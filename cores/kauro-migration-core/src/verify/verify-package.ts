import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { MigrationError } from '../domain/errors.js';
import { compareCodeUnits, parseJson } from '../util/json.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { createCsvScanner, readCsv } from '../ingest/csv-reader.js';
import { countCsvRecords, readCsvFileRecords, readCsvFileRows, scanCsvFile } from '../ingest/read-csv-file.js';
import { decodeSource } from '../ingest/encoding.js';
import { getAdapter } from '../adapters/specs.js';
import { objectSpec } from '../adapters/adapter.js';
import { escapeField } from '../artifacts/csv-writer.js';
import { declaredRelationshipTypes } from '../artifacts/render-package.js';
import { IMPORT_AREA, artifactKind, dataViewPathFor, importPathForDataView, logicalName, packagePath } from '../artifacts/layout.js';
import { PACKAGE_FORMAT_VERSION } from '../version.js';
import { sha256Hex } from '../util/hash.js';
import { importPartsListed } from '../artifacts/import-partition.js';
import { importKeyFor } from '../artifacts/import-key.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import { coGroup, openKeyedSpill as openRawKeyedSpill, spillKeyed as spillRawKeyed } from './join.js';
import { deliveredRows } from './import-rows.js';
import type { DeliveredRow } from './import-rows.js';
import type { Keyed, KeyedSpill } from './join.js';
import type { SpooledFamily } from '../run/spool.js';
import { orderText } from '../run/spool.js';
import type { DestinationAdapter } from '../adapters/adapter.js';
import type { TargetMode } from '../domain/config.js';
import type { CanonicalObject } from '../domain/canonical.js';
import { CANONICAL_OBJECTS } from '../domain/canonical.js';
import { makeColumnLocatorId, makeFileId, makeOccurrenceFileId, makeRowLocatorId } from '../domain/locators.js';
import {
  clusterIdFor,
  edgeIdFor,
  mergeIdFor,
  migrationKeyFromIdentity,
  migrationKeyFromRow,
} from '../identity/migration-key.js';
import { loadConfig } from '../mapping/load-config.js';
import { headerForField, importColumnsFor } from '../artifacts/render-package.js';
import { isReasonCode } from '../domain/reason-codes.js';
import { renderAudit } from '../artifacts/audit.js';
import type { Reconciliation } from '../reconcile/reconcile.js';
import { listPackageFiles, MANIFEST_FILE } from '../artifacts/write-package.js';
import { startsLikeFormula } from '../run/validate-destination.js';
import type { HashedTargetContract } from '../target/contract.js';
import { verifyTargetEvidence } from './target-evidence.js';

/**
 * The package verifier.
 *
 * It knows nothing about the run that produced the package. It opens the
 * directory, reads bytes, and tries to find a way in which the package
 * contradicts itself. It never imports the generator's in-memory state, which
 * is the only way this check is worth anything.
 */

export interface VerificationProblem {
  readonly check: string;
  readonly detail: string;
}

export interface VerificationReport {
  readonly packageDir: string;
  readonly passed: boolean;
  readonly checks: readonly string[];
  readonly problems: readonly VerificationProblem[];
  readonly artifactCount: number;
  readonly sourceRows: number;
}

interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/** Separator used only to build a sort key; it cannot appear in CSV field text. */
const ORDER_SEPARATOR = String.fromCharCode(0);

/** Separator used to key a relationship by its endpoints; likewise not CSV text. */
const PAIR_SEPARATOR = String.fromCharCode(31);

/**
 * A spill whose keys are escaped, which is every spill this file opens.
 *
 * A key here is built out of cells of the package under test: a migration key,
 * a row locator, an edge id, an association label. All of that is text this
 * engine did not write -- the whole point of a verifier is that it is handed
 * bytes and asked whether they contradict themselves -- and the scratch format
 * owns four characters. A key holding one of them does not fail a check; it
 * ends the verification:
 *
 *   NUL      SCRATCH_FAILED: a sort key may not contain a NUL
 *   TAB      SCRATCH_FAILED: a sort key may not contain a tab
 *   LF       SCRATCH_FAILED: a scratch line may not contain a line feed
 *   U+0001   ORDER_KEY_PART_IS_CLEAN: an ordering key part holds the separator
 *
 * All four were run against the compiled store on 2026-09-04 to check that the
 * list is the list. A package that carries any of them in a column a check keys
 * on therefore crashes the engine instead of being reported, which is the one
 * outcome a tamper must never produce: a report with a problem in it is a
 * finding, and a thrown invariant is an outage.
 *
 * `orderText` is the escape the engine already defines for exactly this -- "a
 * key part that may hold anything a source cell held" -- and it is injective,
 * so two values group together after escaping exactly when they were equal
 * before. It was not used here, and this file is where the untrusted text is.
 *
 * The wrapping is done once, on the way in, rather than at each of the two
 * dozen places a key is composed. Site-by-site escaping is how one side of a
 * join ends up escaped and the other raw, which does not fail loudly: the two
 * families simply stop matching on the hostile key and the check reports
 * nothing. Both entry points are shadowed so no call site in this file can
 * reach the unescaped ones by accident.
 *
 * What a caller must know: `group.key` is now the escaped spelling. For
 * anything a well-formed package holds -- an identifier, a label, a locator --
 * it is the same string, because the only characters the escape moves are the
 * ones below U+0020 and the per-cent sign, and the per-cent sign on its own
 * cannot change an order: its escape begins with itself. That is checked
 * rather than reasoned about. Over 355,541 distinct ordered pairs drawn from an
 * alphabet with no character below U+0020, escaping reorders none; over the
 * same number of pairs drawn from an alphabet that includes NUL, U+0001, tab,
 * newline and U+001F it reorders 53,043 -- and every one of those keys ends the
 * verification today, so there is no order there to preserve.
 *
 * Where the raw text is needed afterwards, for a message or for a lookup
 * against text that was never spilled, it travels as the record's value; each
 * place that does so says why.
 */
/**
 * How many instances of one repeated failure are named before the rest are
 * summarised.
 *
 * `fail` appends to an unbounded array, so a rule that calls it per offending
 * cell turns a wrong verdict into an out-of-memory: the apostrophe rule could
 * produce one problem object per row of a million-row European name file.
 */
const REPORTED_EXAMPLES = 5;

function escapeKey<T>(entry: Keyed<T>): Keyed<T> {
  return { k: orderText(entry.k), v: entry.v };
}

function openKeyedSpill<T>(scratch: ScratchStore, schema: string): KeyedSpill<T> {
  const spill = openRawKeyedSpill<T>(scratch, schema);
  return {
    add(entry: Keyed<T>): void {
      spill.add(escapeKey(entry));
    },
    seal(): SpooledFamily<Keyed<T>> {
      return spill.seal();
    },
  };
}

function spillKeyed<T>(scratch: ScratchStore, schema: string, rows: Iterable<Keyed<T>>): SpooledFamily<Keyed<T>> {
  return spillRawKeyed(
    scratch,
    schema,
    (function* () {
      for (const row of rows) yield escapeKey(row);
    })(),
  );
}

/**
 * What one row of each artifact is. A row-per-thing artifact whose rows are
 * validated only by their count is a bag, not a ledger.
 */
const ARTIFACT_KEYS: readonly (readonly [string, readonly string[]])[] = [
  ['source-lineage.csv', ['row_locator_id']],
  ['import-crosswalk.csv', ['import_path', 'import_row_number']],
  ['changes.csv', ['row_locator_id', 'destination_field']],
  ['flags.csv', ['row_locator_id', 'destination_field', 'reason_code']],
  ['unmapped-fields.csv', ['row_locator_id', 'column_index']],
  ['isolated.csv', ['row_locator_id']],
  ['leftovers.csv', ['row_locator_id']],
  ['rejected-input.csv', ['row_locator_id']],
  ['duplicate-candidates.csv', ['cluster_id', 'migration_key']],
  ['associations.csv', ['source_edge_id']],
  ['unresolved-associations.csv', ['source_edge_id']],
  ['destination-conflicts.csv', ['object', 'key_field', 'key_value']],
  ['formula-risk.csv', ['target', 'migration_key', 'destination_field']],
  ['instance-verification.csv', ['scope', 'detail']],
];

/** Isolation reasons caused by a per-cell finding, which flags.csv has to record. */
const FIELD_LEVEL_ISOLATION = new Set([
  'ISOLATED_AMBIGUOUS_FIELD',
  'ISOLATED_INVALID_FIELD',
  'ISOLATED_UNSUPPORTED_FIELD',
  'ISOLATED_FORMULA_CACHED_VALUE',
  'ISOLATED_FORMULA_CACHED_VALUE_ABSENT',
]);

/** Artifacts that repeat a source row's provenance and must repeat it correctly. */
const PROVENANCE_ARTIFACTS = [
  'changes.csv',
  'flags.csv',
  'unmapped-fields.csv',
  'isolated.csv',
  'leftovers.csv',
  'rejected-input.csv',
];

const PROVENANCE_COLUMNS = [
  'bundle_id',
  'file_id',
  'file_sha256',
  'file_path',
  'sheet_id',
  'sheet_name',
  'row_number',
  'row_hash',
];

/**
 * Artifacts whose order is declared elsewhere: `source-lineage.csv` has its own
 * ordering check, and `instance-verification.csv` follows the adapter's own
 * order, which the audit summary pins.
 */
const UNORDERED_ARTIFACTS = new Set(['source-lineage.csv', 'instance-verification.csv']);

/**
 * The order each artifact is written in, column by column and with the column's
 * type.
 *
 * Re-deriving an order from the uniqueness key was wrong twice over: the writer
 * orders source rows by file path, sheet and row *number*, and comparing
 * `row_locator_id` as text puts row 10 before row 2 and orders a multi-file
 * bundle by a content hash instead of by path. A verifier that rejects a
 * correct package is worse than one that misses a tampered one, so the order is
 * declared here rather than guessed.
 */
const ARTIFACT_ORDER: readonly (readonly [string, readonly (readonly [string, 'text' | 'number'])[]])[] = [
  ['import-crosswalk.csv', [['import_path', 'text'], ['import_row_number', 'number']]],
  ['changes.csv', [['file_path', 'text'], ['sheet_id', 'text'], ['row_number', 'number']]],
  ['flags.csv', [['file_path', 'text'], ['sheet_id', 'text'], ['row_number', 'number']]],
  ['isolated.csv', [['file_path', 'text'], ['sheet_id', 'text'], ['row_number', 'number']]],
  ['leftovers.csv', [['file_path', 'text'], ['sheet_id', 'text'], ['row_number', 'number']]],
  ['rejected-input.csv', [['file_path', 'text'], ['sheet_id', 'text'], ['row_number', 'number']]],
  // File, sheet, row, column — the same order every other row-addressed
  // artifact declares. It used to be ordered by the row locator as text, which
  // is a row number compared as a string: row 10 sorted before row 2, and no
  // sheet with fewer than ten unmapped rows in it could show that. The
  // canonical contract forbids ordering a row number as text, and this was the
  // one place still doing it.
  [
    'unmapped-fields.csv',
    [['file_path', 'text'], ['sheet_id', 'text'], ['row_number', 'number'], ['column_index', 'number']],
  ],
  ['duplicate-candidates.csv', [['cluster_id', 'text'], ['migration_key', 'text']]],
  ['associations.csv', [['source_edge_id', 'text']]],
  ['unresolved-associations.csv', [['source_edge_id', 'text']]],
  ['formula-risk.csv', [['target', 'text'], ['migration_key', 'text'], ['destination_field', 'text']]],
];

/** Pads a numeric column so text comparison reproduces numeric comparison. */
function orderCell(value: string, kind: 'text' | 'number'): string {
  if (kind !== 'number') return value;
  return /^[0-9]+$/u.test(value) ? value.padStart(20, '0') : value;
}

const CSV_LIMITS = {
  delimiter: ',',
  maxCellLength: 10_000_000,
  maxColumns: 10_000,
  maxRows: 10_000_000,
};

/**
 * What the lineage says about one source row, without holding the lineage.
 *
 * Six checks want the disposition or the migration key of a row they already
 * have in hand, and the obvious way to answer is an index: read
 * `source-lineage.csv` into a `Map` and look rows up. That index is one entry
 * per source row, three of them existed at once, and together they were the
 * largest thing a verification held.
 *
 * They are not needed, because the artifacts are already co-sorted. Every
 * row-addressed artifact declares the same order -- file path, sheet, then row
 * number as a number -- and `lineage.ordering` has already checked that the
 * lineage is in it before this cursor is opened. So a check that walks its own
 * artifact in order can walk the lineage alongside it and never look back.
 *
 * The cursor refuses a request that goes backwards rather than answering it
 * wrongly. A future check that needs random access has to say so, and gets a
 * spilled join instead of a silent miss.
 */
interface RowFacts {
  readonly disposition: string;
  readonly migrationKey: string;
  readonly recordMappingId: string;
  readonly mergeId: string;
  readonly contributionKind: string;
  readonly reasonCode: string;
  /** The lineage row itself, for the provenance comparison. */
  readonly row: Readonly<Record<string, string>>;
}

interface LineageCursor {
  /** The lineage row at this address, or null if the lineage has none. */
  at(address: Readonly<Record<string, string>>): RowFacts | null;
  /** Releases the file handle the cursor reads through. */
  close(): void;
  /**
   * Whether the artifact doing the asking went backwards.
   *
   * A package whose artifact is out of its declared order is a package this
   * verification is going to reject, and `artifacts.ordering` says so in its
   * own words. The cursor cannot answer for a row it has already passed, so it
   * answers nothing and records why -- rather than throwing, which would end
   * the verification on the first tampered file instead of reporting it.
   */
  readonly disordered: boolean;
}

function openLineageCursor(
  packageDir: string,
  where: string,
  report: (check: string, detail: string) => void,
): LineageCursor {
  const rows = readCsvFileRows(artifactPath(packageDir, 'source-lineage.csv'), {
    ...CSV_LIMITS,
    filePath: 'source-lineage.csv',
  });
  let held: Record<string, string> | null = null;
  let exhausted = false;
  let lastAsked: string | null = null;
  // An artifact may hold several rows for one source row -- a row with two
  // changed fields, a row with three flags -- so the same address is asked for
  // more than once in a row. The answer is remembered rather than re-read,
  // because the lineage row for it has already gone past.
  let lastFacts: RowFacts | null = null;
  let disordered = false;

  const pull = (): void => {
    if (held !== null || exhausted) return;
    const step = rows.next();
    if (step.done === true) {
      exhausted = true;
      return;
    }
    held = step.value;
  };

  return {
    get disordered(): boolean {
      return disordered;
    },

    close(): void {
      rows.return?.(undefined);
    },

    at(address): RowFacts | null {
      const wanted = lineageOrderKey(address);
      if (lastAsked !== null && compareCodeUnits(lastAsked, wanted) > 0) {
        if (!disordered) {
          const [check, file] = where.split(SPLIT_AT);
          report(
            check ?? 'artifacts.ordering',
            `${file ?? where} is not in its declared order, so its rows cannot be matched against the lineage`,
          );
        }
        disordered = true;
        return null;
      }
      if (lastAsked === wanted) return lastFacts;
      lastAsked = wanted;
      lastFacts = null;

      for (;;) {
        pull();
        if (held === null) return null;
        const here = lineageOrderKey(held);
        const order = compareCodeUnits(here, wanted);
        if (order > 0) return null;
        // A row the lineage holds that the asking artifact does not mention is
        // skipped, which is the ordinary case: most source rows are not in
        // `isolated.csv`.
        const row = held;
        held = null;
        if (order === 0) {
          lastFacts = {
            disposition: row['disposition'] ?? '',
            migrationKey: row['migration_key'] ?? '',
            recordMappingId: row['record_mapping_id'] ?? '',
            mergeId: row['merge_id'] ?? '',
            contributionKind: row['contribution_kind'] ?? '',
            reasonCode: row['reason_code'] ?? '',
            row,
          };
          return lastFacts;
        }
      }
    },
  };
}

/** Separates the check that opened a cursor from the artifact it is reading. */
const SPLIT_AT = '/';

/** The declared order of every row-addressed artifact, as one comparable string. */
function lineageOrderKey(row: Readonly<Record<string, string>>): string {
  return [
    row['file_path'] ?? '',
    row['sheet_id'] ?? '',
    orderCell(row['row_number'] ?? '', 'number'),
  ].join(ORDER_SEPARATOR);
}

/**
 * Where the verifier spills the projections it joins on.
 *
 * Host-injected, like the run's: a library that reached for a temporary
 * directory of its own choosing would be deciding where a customer's data
 * lands, under what retention, on whose disk. The host that asked for the
 * verification says where.
 */
/** The most rows of one key a verifier cross-check holds at once. */
export const VERIFY_JOIN_BOUND = 8_192;

export interface VerifyOptions {
  readonly scratch: ScratchStore;
  /**
   * Called as the verification passes each named point.
   *
   * A bounded verifier is a claim about memory, and a claim about memory that
   * cannot be measured where it is made is a claim nobody can check. The
   * measuring is the caller's: it is the caller that knows whether it is
   * running a probe with a heap limit or verifying a package for an operator,
   * and neither the clock nor the environment may reach inside here.
   *
   * Nothing the verification decides depends on this.
   */
  readonly observe?: (where: string) => void;
  /**
   * The most rows of one join key the cross-checks hold at once (B02-R3).
   * Default `VERIFY_JOIN_BOUND`. A parameter so a test can make a small package
   * as skewed as a huge one; nothing the verification decides depends on it.
   */
  readonly joinBound?: number;
  /**
   * Called with the number of rows a skew-bounded join held for one group, so
   * the bound is a thing a test can read rather than a claim.
   */
  readonly observeJoin?: (check: string, held: number) => void;
  /**
   * The target contract the host trusts for the instance this package is for.
   *
   * Without it this is package-only verification, and it establishes nothing
   * about destination eligibility: a package names its contract by digest, the
   * contract is not in the package, and no check here can say whether a value
   * in `01_IMPORT` is one the instance takes. With it, the body must
   * re-establish its own digest, that digest must be the one the package
   * recorded, the package's plan is re-decided against it, and every emitted
   * cell is held to its value-level facts (`target.*` checks).
   *
   * Supplying one for a CLEAN_ONLY package is refused: there is no instance.
   */
  readonly targetContract?: HashedTargetContract | null;
  /**
   * When true, a HUBSPOT or SALESFORCE package verified without a trusted
   * target contract fails rather than passing on structure alone. CLEAN_ONLY
   * is unaffected. Defaults to false, which is the structural verification
   * every earlier version performed.
   */
  readonly requireTargetContract?: boolean;
}

export function verifyPackage(packageDirInput: string, options: VerifyOptions): VerificationReport {
  const scratch = options.scratch;
  const packageDir = resolve(packageDirInput);
  // One reading of each artifact, for the length of this verification only.
  const problems: VerificationProblem[] = [];
  const checks: string[] = [];

  // Opened as checks need them, closed when the verification ends.
  const openCursors: LineageCursor[] = [];

  const observe = options.observe ?? ((): void => {});
  const record = (check: string): void => {
    checks.push(check);
    observe(check);
  };
  const mark = observe;
  const cursor = (where: string): LineageCursor => {
    const opened = openLineageCursor(packageDir, where, fail);
    openCursors.push(opened);
    return opened;
  };
  const fail = (check: string, detail: string): void => {
    problems.push({ check, detail });
  };

  // ---------------------------------------------------------------- manifest
  record('manifest.present');
  const manifestPath = join(packageDir, MANIFEST_FILE);
  let manifest: JsonObject;
  try {
    manifest = parseJson(readFileSync(manifestPath, 'utf8')) as JsonObject;
  } catch (error) {
    throw new MigrationError(
      'PACKAGE_INVALID',
      `${packageDir} has no readable ${MANIFEST_FILE}`,
      'Point the verifier at a directory produced by "kauro-core run".',
      { packageDir, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const artifacts = (manifest['artifacts'] ?? []) as { path: string; kind?: unknown; sha256: string; byteLength: number; rowCount: number | null }[];
  const target = (manifest['target'] ?? {}) as { mode?: string; importMode?: string };

  // A package says which format it is, and this core reads exactly one. A 2.0.0
  // package has no human view and no kinds; it is not quietly read as 2.1.0.
  record('manifest.formatVersion');
  if (manifest['manifestVersion'] !== PACKAGE_FORMAT_VERSION) {
    fail(
      'manifest.formatVersion',
      `the manifest declares package format ${String(manifest['manifestVersion'])} and this core verifies ${PACKAGE_FORMAT_VERSION}`,
    );
  }

  record('manifest.artifactHashes');
  // Hashed and measured in blocks, never held.
  //
  // This loop reads every artifact in the package, and it read each one whole to
  // ask two questions that need no more than a block at a time. At a million
  // rows `unmapped-fields.csv` alone is 424 MB and `source-lineage.csv` a third
  // of a gigabyte, so the first check a verification runs allocated the whole
  // package before any other check had started -- and resident memory never
  // comes back once it has grown, so every later check paid for it too.
  //
  // `digestFile` is the same SHA-256 fed in pieces. It is not a second
  // definition of the hash: the fixtures' manifests are written by `sha256Hex`,
  // which takes its input whole, so every tamper case and the untampered control
  // hold the two forms to the same digest on every artifact of every fixture.
  for (const artifact of artifacts) {
    let measured: FileDigest;
    try {
      measured = digestFile(join(packageDir, ...artifact.path.split('/')));
    } catch {
      fail('manifest.artifactHashes', `${artifact.path} is listed in the manifest but missing from the package`);
      continue;
    }
    if (measured.sha256 !== artifact.sha256) {
      fail('manifest.artifactHashes', `${artifact.path} hashes to ${measured.sha256}, but the manifest says ${artifact.sha256}`);
    }
    if (measured.byteLength !== artifact.byteLength) {
      fail(
        'manifest.artifactHashes',
        `${artifact.path} is ${String(measured.byteLength)} bytes, but the manifest says ${String(artifact.byteLength)}`,
      );
    }
  }

  record('manifest.completeness');
  const onDisk = listPackageFiles(packageDir).filter((path) => path !== MANIFEST_FILE);
  const listedPaths = new Set(artifacts.map((artifact) => artifact.path));
  for (const path of onDisk) {
    if (!listedPaths.has(path)) {
      fail('manifest.completeness', `${path} is in the package but not listed in the manifest`);
    }
  }

  // The same artifacts, by the name the checks below know them by. A check
  // asks whether the package holds `leftovers.csv`, not whether it holds a
  // file at a particular address, so that where an artifact lives stays a
  // property of the layout.
  const listed = new Set(artifacts.map((artifact) => logicalName(artifact.path)));

  record('manifest.ordering');
  const paths = artifacts.map((artifact) => artifact.path);
  if (paths.join('\n') !== [...paths].sort(compareCodeUnits).join('\n')) {
    fail('manifest.ordering', 'the manifest artifact list is not in sorted order, so the package is not reproducible');
  }

  // ---------------------------------------------------------- reconciliation
  record('reconciliation.parses');
  const reconciliation = readJson(packageDir, 'reconciliation.json') as unknown as Reconciliation;

  record('reconciliation.equation');
  // Recomputed here rather than read. Trusting `equationHolds` would let an
  // edited reconciliation assert its own correctness.
  const dispositionTotal = Object.values(reconciliation.sourceRows.byDisposition).reduce(
    (sum, value) => sum + value,
    0,
  );
  const manifestInputs = (manifest['inputs'] ?? []) as {
    sheets?: { readerRowCount: number; dataRowCount: number; rejectedRowCount: number }[];
  }[];
  const rowsRead = manifestInputs.reduce(
    (sum, file) => sum + (file.sheets ?? []).reduce((inner, sheet) => inner + sheet.readerRowCount, 0),
    0,
  );
  // The reader's own count must also equal what it sorted into accepted and
  // rejected. Checking both keeps the comparison anchored where the rows were
  // produced rather than where they were filed.
  for (const file of manifestInputs) {
    for (const sheet of file.sheets ?? []) {
      if (sheet.readerRowCount !== sheet.dataRowCount + sheet.rejectedRowCount) {
        fail(
          'reconciliation.equation',
          `a sheet reports ${String(sheet.readerRowCount)} rows read but ${String(sheet.dataRowCount + sheet.rejectedRowCount)} accepted or rejected`,
        );
      }
    }
  }

  if (dispositionTotal !== reconciliation.sourceRows.accountedFor) {
    fail(
      'reconciliation.equation',
      `the dispositions add up to ${String(dispositionTotal)} but the reconciliation claims ${String(reconciliation.sourceRows.accountedFor)}`,
    );
  }
  if (rowsRead !== reconciliation.sourceRows.ingested) {
    fail(
      'reconciliation.equation',
      `the manifest records ${String(rowsRead)} rows read but the reconciliation claims ${String(reconciliation.sourceRows.ingested)}`,
    );
  }
  if (rowsRead !== dispositionTotal) {
    fail(
      'reconciliation.equation',
      `${String(rowsRead)} rows were read from the input files but ${String(dispositionTotal)} dispositions were assigned`,
    );
  }
  if (reconciliation.sourceRows.withoutDisposition !== 0) {
    fail('reconciliation.equation', 'the reconciliation reports rows with no disposition');
  }

  // Three numbers, as with rows: the count taken where the candidates were
  // produced and written into the manifest, the reconciliation's claim, and the
  // tally of the dispositions in the ledger. Comparing only the last two is an
  // identity that holds however many relationships were lost.
  const relationshipCandidates = manifest['relationshipCandidates'];
  const candidateCount = typeof relationshipCandidates === 'number' ? relationshipCandidates : -1;
  const ledgerEdges = countTableRows(packageDir, 'associations.csv');
  if (candidateCount < 0) {
    fail('reconciliation.equation', 'the manifest does not record how many relationship candidates were built');
  } else {
    if (candidateCount !== ledgerEdges) {
      fail(
        'reconciliation.equation',
        `the manifest records ${String(candidateCount)} relationship candidates but the ledger holds ${String(ledgerEdges)}`,
      );
    }
    if (candidateCount !== reconciliation.associations.sourceEdges) {
      fail(
        'reconciliation.equation',
        `the manifest records ${String(candidateCount)} relationship candidates but the reconciliation claims ${String(reconciliation.associations.sourceEdges)}`,
      );
    }
  }

  const edgeTotal = Object.values(reconciliation.associations.byDisposition).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (edgeTotal !== reconciliation.associations.sourceEdges) {
    fail(
      'reconciliation.equation',
      `relationship dispositions add up to ${String(edgeTotal)} but ${String(reconciliation.associations.sourceEdges)} relationships are claimed`,
    );
  }

  // ------------------------------------------------------------------ config
  record('config.present');
  const configText = readText(packageDir, 'config.normalized.json');
  const loaded = loadConfig(configText, 'config.normalized.json');
  const vendor = (target.mode ?? reconciliation.target.mode) as TargetMode;
  const adapter = getAdapter(vendor);

  if (loaded.configHash !== reconciliation.configHash) {
    fail(
      'config.present',
      `the configuration in the package hashes to ${loaded.configHash}, but the reconciliation says ${reconciliation.configHash}`,
    );
  }

  // --------------------------------------------------------- target evidence
  //
  // Only when the host supplies a contract or requires one. The default call
  // is the structural verification every earlier version performed, and it
  // says nothing about whether the destination takes what 01_IMPORT holds.
  if (options.targetContract !== undefined || options.requireTargetContract === true) {
    const recorded = (manifest['target'] as JsonObject | undefined)?.['targetContractHash'] ?? null;
    verifyTargetEvidence({
      packageDir,
      mode: vendor,
      recordedContractHash: typeof recorded === 'string' && recorded !== '' ? recorded : null,
      adapter,
      config: loaded.config,
      supplied: options.targetContract ?? null,
      required: options.requireTargetContract === true,
      limits: CSV_LIMITS,
      record,
      fail,
    });
  }

  // ----------------------------------------------------------------- lineage
  //
  // One pass, four checks. The lineage is the largest artifact a package holds —
  // at a million rows it is a third of a gigabyte — and it used to be read into
  // memory once and then walked four separate times: for its length, for the
  // duplicate check, for the disposition tally, and again to build an array of
  // every order key to compare against a sorted copy of itself. Two full-size
  // copies of the artifact to answer whether it was in order.
  //
  // Now it is read in blocks and every check accumulates as the rows go past.
  // Order is checked by comparing each key with the one before it, which is the
  // same question and needs one string rather than two arrays.
  record('lineage.coverage');
  record('lineage.singleDisposition');
  record('lineage.tallies');
  record('lineage.ordering');

  const orderKey = (row: Readonly<Record<string, string>>): string =>
    `${row['file_path'] ?? ''}${ORDER_SEPARATOR}${row['sheet_id'] ?? ''}${ORDER_SEPARATOR}${(row['row_number'] ?? '').padStart(12, '0')}`;

  // One row per source row, counted and checked in one pass, with nothing kept
  // per row.
  //
  // A duplicate row locator used to be found with a set of every locator in the
  // file. It does not need one: two rows for the same locator have the same
  // order key, so in a file this check has already established to be in order
  // they are adjacent, and comparing each row with the one before it finds them.
  // The tally is per disposition, of which there are five.
  //
  // What a row is -- its disposition, its migration key -- is answered by
  // walking the lineage alongside whichever artifact is asking, which is what
  // `openLineageCursor` is for. Three maps of one entry per source row used to
  // answer it, and together they were the largest thing a verification held.
  const tally = new Map<string, number>();
  let lineageRows = 0;
  let previousLineageOrder: string | null = null;
  let previousLocator: string | null = null;
  let lineageOutOfOrder = false;

  scanTable(packageDir, 'source-lineage.csv', () => (row) => {
    lineageRows += 1;
    const id = row['row_locator_id'] ?? '';
    if (previousLocator === id) {
      fail('lineage.singleDisposition', `row ${id} appears more than once in source-lineage.csv`);
    }
    previousLocator = id;

    const disposition = row['disposition'] ?? '';
    tally.set(disposition, (tally.get(disposition) ?? 0) + 1);

    const key = orderKey(row);
    if (previousLineageOrder !== null && compareCodeUnits(previousLineageOrder, key) > 0) lineageOutOfOrder = true;
    previousLineageOrder = key;
  });

  mark('after the lineage scan');
  if (lineageRows !== reconciliation.sourceRows.total) {
    fail(
      'lineage.coverage',
      `source-lineage.csv has ${String(lineageRows)} rows but the reconciliation counts ${String(reconciliation.sourceRows.total)} source rows`,
    );
  }

  for (const [disposition, expected] of Object.entries(reconciliation.sourceRows.byDisposition)) {
    const actual = tally.get(disposition) ?? 0;
    if (actual !== expected) {
      fail(
        'lineage.tallies',
        `source-lineage.csv holds ${String(actual)} rows with disposition ${disposition}, but the reconciliation says ${String(expected)}`,
      );
    }
  }

  if (lineageOutOfOrder) {
    fail('lineage.ordering', 'source-lineage.csv is not in its declared deterministic order');
  }

  // ------------------------------------------------------------ spilled joins
  //
  // Two projections of the lineage, spilled once and walked as often as needed.
  //
  // Checks that walk a row-addressed artifact use `openLineageCursor`, because
  // those artifacts are co-sorted with the lineage and nothing has to be kept.
  // The rest -- merges, destination conflicts, the association ledger -- are
  // ordered by something else entirely, so they are matched by spilling both
  // sides through the host's scratch store and walking them in step. What is
  // held is one key's worth of rows, not one entry per source row.
  let lineageByLocatorFamily: SpooledFamily<Keyed<{ disposition: string; migrationKey: string }>> | null = null;
  const lineageByLocator = (): SpooledFamily<Keyed<{ disposition: string; migrationKey: string }>> => {
    if (lineageByLocatorFamily !== null) return lineageByLocatorFamily;
    lineageByLocatorFamily = spillKeyed(
      scratch,
      'verify-lineage-by-locator',
      (function* () {
        for (const row of readCsvFileRows(artifactPath(packageDir, 'source-lineage.csv'), {
          ...CSV_LIMITS,
          filePath: 'source-lineage.csv',
        })) {
          yield {
            k: row['row_locator_id'] ?? '',
            v: { disposition: row['disposition'] ?? '', migrationKey: row['migration_key'] ?? '' },
          };
        }
      })(),
    );
    return lineageByLocatorFamily;
  };

  let deliveredFamily: SpooledFamily<Keyed<DeliveredRow>> | null = null;
  const deliveredRecords = (): SpooledFamily<Keyed<DeliveredRow>> => {
    if (deliveredFamily !== null) return deliveredFamily;
    deliveredFamily = spillKeyed(
      scratch,
      'verify-delivered-records',
      deliveredRows(packageDir, adapter, loaded.config, CSV_LIMITS),
    );
    return deliveredFamily;
  };

  let recordsByKeyFamily: SpooledFamily<Keyed<{ rowLocatorId: string }>> | null = null;
  const recordsByKey = (): SpooledFamily<Keyed<{ rowLocatorId: string }>> => {
    if (recordsByKeyFamily !== null) return recordsByKeyFamily;
    recordsByKeyFamily = spillKeyed(
      scratch,
      'verify-records-by-key',
      (function* () {
        for (const row of readCsvFileRows(artifactPath(packageDir, 'source-lineage.csv'), {
          ...CSV_LIMITS,
          filePath: 'source-lineage.csv',
        })) {
          if ((row['contribution_kind'] ?? '') !== 'RECORD') continue;
          const key = row['migration_key'] ?? '';
          if (key === '') continue;
          yield { k: key, v: { rowLocatorId: row['row_locator_id'] ?? '' } };
        }
      })(),
    );
    return recordsByKeyFamily;
  };

  // ---------------------------------------------------- disposition artifacts
  mark('before the disposition artifacts');
  record('dispositionArtifacts.agree');
  for (const [file, disposition] of [
    ['isolated.csv', 'ISOLATED'],
    ['leftovers.csv', 'LEFTOVER'],
    ['rejected-input.csv', 'REJECTED_INPUT'],
  ] as const) {
    const expected = reconciliation.sourceRows.byDisposition[disposition as keyof typeof reconciliation.sourceRows.byDisposition];
    let held = 0;
    // The lineage is walked alongside this artifact rather than indexed: both
    // declare the same order, and `lineage.ordering` has already checked that
    // the lineage is in it.
    const lineage = cursor(`dispositionArtifacts.agree/${file}`);
    scanTable(packageDir, file, () => (row) => {
      held += 1;
      const id = row['row_locator_id'] ?? '';
      const facts = lineage.at(row);
      if (facts?.disposition !== disposition) {
        fail(
          'dispositionArtifacts.agree',
          `${file} lists ${id}, whose lineage disposition is ${facts === null ? 'absent' : facts.disposition}`,
        );
      }
    });
    if (held !== expected) {
      fail(
        'dispositionArtifacts.agree',
        `${file} holds ${String(held)} rows but the reconciliation counts ${String(expected)} ${disposition} rows`,
      );
    }
  }

  // ----------------------------------------------------------------- changes
  //
  // Both checks in one pass. The change log is the second-largest artifact a
  // package holds, and reading it whole to walk it twice held it for the rest of
  // the verification.
  mark('before the change log');
  record('changes.consistency');
  record('changes.noSilentDestruction');
  let changeRows = 0;
  const changeLineage = cursor('changes.consistency/changes.csv');
  scanTable(packageDir, 'changes.csv', () => (row) => {
    changeRows += 1;
    const original = row['original_value'] ?? '';
    const final = row['final_value'] ?? '';

    if (original === final) {
      fail('changes.consistency', `changes.csv records ${row['row_locator_id'] ?? ''}/${row['destination_field'] ?? ''} but nothing changed`);
    }
    if (changeLineage.at(row) === null) {
      fail('changes.consistency', `changes.csv refers to ${row['row_locator_id'] ?? ''}, which has no lineage entry`);
    }
    if ((row['reason_code'] ?? '') === '') {
      fail('changes.consistency', `changes.csv row for ${row['row_locator_id'] ?? ''} carries no reason code`);
    }

    if (original.length > 0 && final.length === 0) {
      if ((row['reason_code'] ?? '') !== 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION') {
        fail(
          'changes.noSilentDestruction',
          `${row['row_locator_id'] ?? ''}/${row['destination_field'] ?? ''} went from a populated value to an empty one under reason ${row['reason_code'] ?? ''}`,
        );
      }
    }
  });
  if (changeRows !== reconciliation.cells.changed) {
    fail(
      'changes.consistency',
      `changes.csv holds ${String(changeRows)} rows but the reconciliation counts ${String(reconciliation.cells.changed)} changed cells`,
    );
  }

  // ------------------------------------------------------------------ merges
  record('merges.lineage');
  const mergesJson = readJson(packageDir, 'merges.json') as { merges?: unknown };
  const merges = (mergesJson.merges ?? []) as {
    mergeId: string;
    survivorRowLocatorId: string;
    survivorMigrationKey: string;
    absorbedRowLocatorIds: string[];
    identityEvidence: { authority: string; value?: string }[];
    conflicts?: { reasonCode: string; semanticsClass: string; values?: { rowLocatorId?: string }[] }[];
    fieldDecisions?: { reasonCode: string }[];
  }[];
  if (merges.length !== reconciliation.identity.provenMerges) {
    fail(
      'merges.lineage',
      `merges.json holds ${String(merges.length)} merges but the reconciliation counts ${String(reconciliation.identity.provenMerges)}`,
    );
  }
  for (const merge of merges) {
    if (!merge.identityEvidence.some((item) => item.authority === 'PROVING')) {
      fail('merges.lineage', `merge ${merge.mergeId} records no proving identity evidence`);
    }
  }

  // What each row a merge names is, according to the lineage. Merges are
  // ordered by merge id and the lineage by file and row, so the two are
  // brought into one order by spilling both rather than by indexing either.
  for (const group of coGroup(
    spillKeyed(
      scratch,
      'verify-merge-rows',
      (function* () {
        for (const merge of merges) {
          yield { k: merge.survivorRowLocatorId, v: { mergeId: merge.mergeId, role: 'SURVIVOR' } };
          for (const absorbed of merge.absorbedRowLocatorIds) {
            yield { k: absorbed, v: { mergeId: merge.mergeId, role: 'ABSORBED' } };
          }
        }
      })(),
    ),
    lineageByLocator(),
  )) {
    const facts = group.right[0] ?? null;
    for (const reference of group.left) {
      if (reference.role === 'SURVIVOR') {
        if (facts === null) {
          fail(
            'merges.lineage',
            `merge ${reference.mergeId} names survivor ${group.key}, which has no lineage entry`,
          );
        }
        continue;
      }
      if (facts?.disposition !== 'MERGED_PROVEN') {
        fail(
          'merges.lineage',
          `merge ${reference.mergeId} absorbs ${group.key}, whose lineage disposition is ${facts === null ? 'absent' : facts.disposition}`,
        );
      }
    }
  }

  // ------------------------------------------------------------ associations
  mark('before the association ledger');
  record('associations.partition');
  record('associations.deliveredOnce');
  // Both association checks in one pass, and the duplicate tests are adjacent
  // comparisons rather than sets: associations.csv is written in edge-id order,
  // so a repeated id is next to the one it repeats.
  //
  // The delivered-pair test cannot use adjacency, because two rows delivering
  // the same relationship need not be adjacent: the ledger is ordered by edge
  // id, and an edge id follows from the row and the raw keys that declared it,
  // not from the pair it resolves to. It held a set of every delivered pair
  // instead — "bounded by the delivered edges rather than by every edge", which
  // in a dense association graph is the same order of magnitude and the largest
  // thing this check touched. The merge that comment said was owed is done here:
  // the pairs are spilled in pair order and grouped, so what is held is one
  // pair's worth of rows.
  const edgeTally = new Map<string, number>();
  // The pair travels as the record as well as the key. An association label is
  // free text, so the escaped key is not always the spelling a person typed --
  // a label holding a per-cent sign reads back as `%25` -- and the failure below
  // quotes the relationship. The key groups; the record is what is said.
  const deliveredPairs = openKeyedSpill<string>(scratch, 'verify-delivered-pairs');
  let edgeRows = 0;
  let previousEdgeId: string | null = null;
  scanTable(packageDir, 'associations.csv', () => (row) => {
    edgeRows += 1;
    const id = row['source_edge_id'] ?? '';
    if (previousEdgeId !== null && id === previousEdgeId) {
      fail('associations.partition', `edge ${id} appears more than once`);
    }
    previousEdgeId = id;
    const disposition = row['disposition'] ?? '';
    edgeTally.set(disposition, (edgeTally.get(disposition) ?? 0) + 1);

    if (disposition !== 'OUTPUT') return;
    const key = `${row['relationship_type'] ?? ''}|${row['from_migration_key'] ?? ''}|${row['to_migration_key'] ?? ''}|${row['label'] ?? ''}`;
    deliveredPairs.add({ k: key, v: key });
    if ((row['from_migration_key'] ?? '') === '' || (row['to_migration_key'] ?? '') === '') {
      fail('associations.deliveredOnce', `edge ${row['source_edge_id'] ?? ''} is delivered without both endpoints resolved`);
    }
  });
  // One failure per extra delivery, which is what reporting on the second and
  // every later occurrence gave. A pair delivered three times is two rows this
  // package should not hold, and saying so once would understate it.
  for (const group of coGroup(deliveredPairs.seal(), [])) {
    const pair = group.left[0] ?? group.key;
    for (let extra = 1; extra < group.left.length; extra += 1) {
      fail('associations.deliveredOnce', `relationship ${pair} is delivered more than once`);
    }
  }
  if (edgeRows !== reconciliation.associations.sourceEdges) {
    fail(
      'associations.partition',
      `associations.csv holds ${String(edgeRows)} edges but the reconciliation counts ${String(reconciliation.associations.sourceEdges)}`,
    );
  }
  for (const [disposition, expected] of Object.entries(reconciliation.associations.byDisposition)) {
    const actual = edgeTally.get(disposition) ?? 0;
    if (actual !== expected) {
      fail(
        'associations.partition',
        `associations.csv holds ${String(actual)} edges with disposition ${disposition}, but the reconciliation says ${String(expected)}`,
      );
    }
  }

  record('associations.unresolvedListed');
  const expectedUnresolved =
    reconciliation.associations.byDisposition.UNRESOLVED + reconciliation.associations.byDisposition.LEFTOVER;
  let unresolvedRows = 0;
  scanTable(packageDir, 'unresolved-associations.csv', () => (row) => {
    unresolvedRows += 1;
    if ((row['reason_code'] ?? '') === '') {
      fail('associations.unresolvedListed', `edge ${row['source_edge_id'] ?? ''} has no reason code`);
    }
  });
  if (unresolvedRows !== expectedUnresolved) {
    fail(
      'associations.unresolvedListed',
      `unresolved-associations.csv holds ${String(unresolvedRows)} rows but ${String(expectedUnresolved)} edges are not delivered`,
    );
  }

  // ------------------------------------------------------------ import files
  mark('before the import files');
  record('import.structure');
  record('crosswalk.structure');
  //
  // The crosswalk is how an import row is tied to the record and the source
  // rows behind it, now that 01_IMPORT carries no Kauro identity of its own. It
  // is not a convenience: it is the only witness that a given line in a given
  // import file is the record the evidence talks about, so it is checked against
  // each import file position by position.
  //
  // Both are read as streams. Holding the crosswalk was one entry per delivered
  // record; holding the import rows was the whole delivered dataset, and it was
  // the largest structure in this verification.
  const importRowsByObject = new Map<CanonicalObject, number>();

  for (const mappingObject of uniqueObjects(loaded.config)) {
    const spec = objectSpec(adapter, mappingObject.object);
    if (spec === null) continue;
    // One object's import file, or the numbered parts it was cut into.
    //
    // A file larger than the destination accepts is now cut rather than refused,
    // so "the file for this object" is a set of one or more paths. The rule is
    // checkable from the listing alone — either the base name on its own, or
    // parts numbered from 001 with no gap and no base name beside them — because
    // the verifier reads a package somebody hands it and has no access to the
    // plan that produced it.
    const basePath = `${IMPORT_AREA}/${adapter.importDirectory}/${spec.fileName}`;
    const partsListed = importPartsListed(basePath, listed);
    if (partsListed.problem !== null) {
      fail('import.structure', partsListed.problem);
      continue;
    }

    const expectedHeaders = importColumnsFor(adapter, loaded.config, mappingObject.object);
    const rowCap = adapter.fileConstraints.maxRowsPerFile;
    const columnCap = adapter.fileConstraints.maxColumnsPerFile;
    const headerCap = adapter.fileConstraints.maxHeaderRowCharacters;

    // Ordering and duplication are properties of the object's records, not of
    // one part of one file, so they carry across the cut. A key that went
    // backwards at a part boundary would otherwise pass: each part is ordered on
    // its own and the sequence is not.
    let previousKey: string | null = null;
    let unordered = false;
    let duplicated = false;

    for (const path of partsListed.paths) {
    // This file's crosswalk rows, in file order, pulled one at a time.
    const named = (function* () {
      for (const row of readCsvFileRows(artifactPath(packageDir, 'import-crosswalk.csv'), {
        ...CSV_LIMITS,
        filePath: 'import-crosswalk.csv',
      })) {
        if ((row['import_path'] ?? '') !== path) continue;
        yield row;
      }
    })();

    let rows = 0;
    let carriesKey = false;

    scanTable(packageDir, path, (headers) => {
      if (headers.join(',') !== expectedHeaders.join(',')) {
        fail(
          'import.structure',
          `${path} headers are [${headers.join(', ')}] but the configuration and adapter imply [${expectedHeaders.join(', ')}]`,
        );
      }
      if (columnCap !== null && headers.length > columnCap) {
        fail(
          'import.structure',
          `${path} has ${String(headers.length)} columns, above the ${String(columnCap)} the destination accepts`,
        );
      }
      if (headerCap !== null && headers.join(',').length > headerCap) {
        fail('import.structure', `${path} has a header row longer than the destination accepts`);
      }
      carriesKey = headers[0] === adapter.associationKeyHeader;

      // The vendor's own limits, checked per row from the columns that declare
      // one rather than from a table held in memory.
      const capped = (objectSpec(adapter, mappingObject.object)?.fields ?? []).filter(
        (entry) => entry.maxLength !== null && headers.includes(entry.header),
      );

      return (row) => {
        rows += 1;
        const entry = named.next();
        if (entry.done === true) {
          // The crosswalk stops before the file does. The count comparison
          // below says so once; there is nothing to check this row against.
          return;
        }
        const crosswalked = entry.value;
        const migrationKey = crosswalked['migration_key'] ?? '';

        if (previousKey !== null) {
          if (compareCodeUnits(previousKey, migrationKey) > 0) unordered = true;
          if (previousKey === migrationKey) duplicated = true;
        }
        previousKey = migrationKey;

        const expectedKey = carriesKey ? importKeyFor(reconciliation.runId, migrationKey) : '';
        if ((crosswalked['association_key'] ?? '') !== expectedKey) {
          fail(
            'crosswalk.structure',
            `${path} row ${String(rows)} is crosswalked to association key "${crosswalked['association_key'] ?? ''}", which is not the key for ${migrationKey}`,
          );
        }
        // The position is the join, so it has to be the position: a crosswalk
        // that numbers its rows freely could name the right records in the wrong
        // places and every hash in the package would still be correct.
        if ((crosswalked['import_row_number'] ?? '') !== String(rows)) {
          fail(
            'crosswalk.structure',
            `${path} row ${String(rows)} is crosswalked as row ${crosswalked['import_row_number'] ?? ''}`,
          );
        }
        if ((crosswalked['object'] ?? '') !== mappingObject.object) {
          fail(
            'crosswalk.structure',
            `${path} row ${String(rows)} is crosswalked as ${crosswalked['object'] ?? ''}, but the file holds ${mappingObject.object} records`,
          );
        }
        if (carriesKey && (row[adapter.associationKeyHeader] ?? '') !== expectedKey) {
          fail(
            'import.structure',
            `${path} row ${String(rows)} carries association key "${row[adapter.associationKeyHeader] ?? ''}" where the crosswalk says ${expectedKey}`,
          );
        }

        for (const field of capped) {
          const value = row[field.header] ?? '';
          if (field.maxLength === null || value.length <= field.maxLength) continue;
          fail(
            'import.vendorConstraints',
            `${path} column ${field.header} holds ${String(value.length)} characters, above the ${String(field.maxLength)} the destination accepts`,
          );
        }
      };
    });

    if (rowCap !== null && rows > rowCap) {
      fail(
        'import.structure',
        `${path} holds ${String(rows)} rows, above the ${String(rowCap)} the destination accepts per file`,
      );
    }
    // Whatever the crosswalk holds beyond this file's last row.
    let extra = 0;
    for (;;) {
      const step = named.next();
      if (step.done === true) break;
      extra += 1;
    }
    if (extra > 0) {
      fail(
        'crosswalk.structure',
        `${path} holds ${String(rows)} rows but the crosswalk accounts for ${String(rows + extra)}`,
      );
    }

    importRowsByObject.set(mappingObject.object, (importRowsByObject.get(mappingObject.object) ?? 0) + rows);
    }

    // Across every part, once, for the reason above.
    if (duplicated) fail('import.structure', `${basePath} contains duplicate migration keys`);
    if (unordered) {
      fail('import.structure', `${basePath} rows are not in migration key order, so the package is not reproducible`);
    }
  }

  record('import.recordCounts');
  // Every object, not every key the reconciliation happens to carry. Iterating
  // the reconciliation's own keys let a deleted key silently skip the check for
  // that object, so records could be removed from an import file and the
  // package would still verify.
  let deliveredTotal = 0;
  for (const object of CANONICAL_OBJECTS) {
    const expected = reconciliation.records.byObject[object] ?? 0;
    const actual = importRowsByObject.get(object) ?? 0;
    deliveredTotal += actual;
    if (actual !== expected) {
      fail(
        'import.recordCounts',
        `the import files hold ${String(actual)} ${object} records but the reconciliation counts ${String(expected)}`,
      );
    }
  }
  if (deliveredTotal !== reconciliation.records.deliveredTotal) {
    fail(
      'import.recordCounts',
      `the import files hold ${String(deliveredTotal)} records in total but the reconciliation claims ${String(reconciliation.records.deliveredTotal)}`,
    );
  }

  record('associations.endpointsDelivered');
  // Both ends of every delivered edge are in an import file. Spilled and merged
  // rather than checked against a set of every delivered key.
  {
    const endpoints = openKeyedSpill<{ edgeId: string }>(scratch, 'verify-edge-endpoints');
    scanTable(packageDir, 'associations.csv', () => (row) => {
      if ((row['disposition'] ?? '') !== 'OUTPUT') return;
      for (const side of ['from_migration_key', 'to_migration_key'] as const) {
        endpoints.add({ k: row[side] ?? '', v: { edgeId: row['source_edge_id'] ?? '' } });
      }
    });
    for (const group of coGroup(
      endpoints.seal(),
      deliveredRecords(),
    )) {
      if (group.left.length === 0 || group.right.length > 0) continue;
      for (const endpoint of group.left) {
        fail(
          'associations.endpointsDelivered',
          `edge ${endpoint.edgeId} points at ${group.key}, which is not in any import file`,
        );
      }
    }
  }

  record('lineage.migrationKeysDelivered');
  {
    const delivered = openKeyedSpill<{ rowLocatorId: string }>(scratch, 'verify-output-rows');
    scanTable(packageDir, 'source-lineage.csv', () => (row) => {
      if ((row['disposition'] ?? '') !== 'OUTPUT' || (row['contribution_kind'] ?? '') !== 'RECORD') return;
      delivered.add({ k: row['migration_key'] ?? '', v: { rowLocatorId: row['row_locator_id'] ?? '' } });
    });
    for (const group of coGroup(
      delivered.seal(),
      deliveredRecords(),
    )) {
      if (group.left.length === 0 || group.right.length > 0) continue;
      for (const entry of group.left) {
        fail(
          'lineage.migrationKeysDelivered',
          `row ${entry.rowLocatorId} is marked OUTPUT but its migration key ${group.key} is not in any import file`,
        );
      }
    }
  }

  // --------------------------------------------------------- CSV safety rule
  mark('before the csv safety rule');
  record('csvSafety.noValueRewriting');

  /**
   * An apostrophe is evidence of a rewrite only where the package says it
   * rewrote the cell.
   *
   * This check failed on `'Ada`. It fired on any delivered value whose first
   * character was an apostrophe, and a leading apostrophe is ordinary data: the
   * Irish and Scottish surnames, the Dutch `'s-Hertogenbosch` and `'t Veld`, an
   * elided year like `'85`, marketing copy beginning `'Twas`, and every value a
   * legacy exporter text-forced on its way out of somebody else's spreadsheet. A
   * European name file failed a package that was correct.
   *
   * It could not have been a true positive either. The machine-import CSV
   * contract is that nothing is prefixed or escaped for spreadsheet display —
   * see `src/artifacts/csv-writer.ts`, DECISIONS D7 and CONTRACT §15 — and no
   * code path in this engine adds an apostrophe. What the check was reaching for
   * is a package where escaping *was* applied, and the package says so itself:
   * `changes.csv` carries `original_value` and `final_value` for every cell the
   * engine altered, so an introduced apostrophe is a change whose final value
   * begins with one and whose original value does not. A cell with no change row
   * is the package asserting it was delivered verbatim.
   *
   * Streamed, so the cost is one pass over a file this verification reads
   * anyway, and the failures are capped — the old rule called `fail` once per
   * offending cell into an unbounded array, so a million-row Irish dataset could
   * exhaust the heap producing the wrong answer.
   */
  let introducedEscapes = 0;
  scanTable(packageDir, 'changes.csv', () => (row) => {
    const before = row['original_value'] ?? '';
    const after = row['final_value'] ?? '';
    // Exactly one apostrophe, prepended, and nothing else changed.
    //
    // The first version of this rule asked whether the final value begins with
    // an apostrophe and the original does not, and that is a different question
    // with an ordinary answer: a source cell of ` 'Twas` trimmed under
    // TRANSFORM_WHITESPACE_TRIMMED produces exactly that pair. The European name
    // file that used to fail on `'Ada` would have failed on ` 'Ada` instead —
    // the same customer, the same column, one leading space apart.
    //
    // Spreadsheet escaping is prepending an apostrophe and changing nothing
    // else, so that is what is looked for.
    if (after !== `'${before}` || before === '') return;
    introducedEscapes += 1;
    if (introducedEscapes <= REPORTED_EXAMPLES) {
      fail(
        'csvSafety.noValueRewriting',
        `changes.csv records ${row['row_locator_id'] ?? ''} ${row['destination_field'] ?? ''} delivered with a leading apostrophe the ` +
          `source did not have, under reason ${row['reason_code'] ?? ''}: spreadsheet escaping was applied to a machine import file`,
      );
    }
  });
  if (introducedEscapes > REPORTED_EXAMPLES) {
    fail(
      'csvSafety.noValueRewriting',
      `${String(introducedEscapes)} changes introduce a leading apostrophe in total; the first ${String(REPORTED_EXAMPLES)} are named above`,
    );
  }

  // The count, both sides denominated the same way.
  //
  // This compared a per-cell counter against `declaredRisk.size`, the
  // cardinality of a de-duplicating Set built from a whole read of
  // formula-risk.csv. A count against a cardinality is not a comparison: two
  // rows declaring the same (key, field) collapsed to one on the left and stayed
  // two on the right. Both sides are row counts now, which also means a package
  // that declares the same risk twice is visible rather than smoothed — and the
  // file is counted by streaming rather than parsed into memory, which matters
  // because every E.164 phone number the engine produces begins with a plus and
  // is therefore a formula risk. A million contacts with two phone columns is a
  // two-million-row file.
  // What a package-only verification can and cannot settle about escaping.
  //
  // It cannot read the source, so it cannot know whether a delivered value that
  // begins with an apostrophe had one in the spreadsheet it came from. Two other
  // things settle that, and neither is a heuristic: every artifact's digest is
  // in manifest.json and is checked here, so a package edited after it was
  // written fails on the digest rather than on the shape of a value; and
  // `verifyAgainstSource` re-derives the migration from the original bytes and
  // compares delivered cells position by position, which is where a value the
  // writer altered is caught exactly.
  //
  // So the count of such values is recorded as an observation rather than
  // treated as a defect. A reader who wants to know how many there are can see
  // it; nobody's package fails for holding an Irish surname.
  let apostropheLeadingValues = 0;

  const declaredRiskRows = countTableRows(packageDir, 'formula-risk.csv');
  let observedRisk = 0;
  for (const artifact of artifacts) {
    if (!artifact.path.startsWith(`${IMPORT_AREA}/${adapter.importDirectory}/`)) continue;
    // Streamed, and one header list per file rather than one row map at a
    // time: the import files are the whole delivered dataset, so reading one
    // whole to look for an apostrophe was the single largest thing this
    // verification held.
    scanTable(packageDir, artifact.path, (headers) => (row) => {
      for (const header of headers) {
        const value = row[header] ?? '';
        if (startsLikeFormula(value)) observedRisk += 1;
        if (value.startsWith("'") && value.length > 1) apostropheLeadingValues += 1;
      }
    });
  }
  if (observedRisk !== declaredRiskRows) {
    fail(
      'csvSafety.noValueRewriting',
      `${String(observedRisk)} delivered values begin like a spreadsheet formula but formula-risk.csv holds ${String(declaredRiskRows)} rows`,
    );
  }
  mark(`csvSafety: ${String(apostropheLeadingValues)} delivered values begin with an apostrophe, which is data rather than escaping`);

  // ------------------------------------------------------- reason code registry
  record('reasonCodes.registered');
  const reasonColumns: [string, string][] = [
    ['source-lineage.csv', 'reason_code'],
    ['changes.csv', 'reason_code'],
    ['flags.csv', 'reason_code'],
    ['unmapped-fields.csv', 'reason_code'],
    ['isolated.csv', 'reason_code'],
    ['leftovers.csv', 'reason_code'],
    ['rejected-input.csv', 'reason_code'],
    ['associations.csv', 'reason_code'],
    ['duplicate-candidates.csv', 'reason_code'],
    ['duplicate-candidates.csv', 'not_merged_reason_code'],
    ['destination-conflicts.csv', 'reason_code'],
    ['formula-risk.csv', 'reason_code'],
    ['instance-verification.csv', 'reason_code'],
  ];
  for (const [file, column] of reasonColumns) {
    if (!listed.has(file)) continue;
    // Streamed: source-lineage.csv and changes.csv are one row per source row
    // and per changed cell, so reading either whole to look at one column of
    // it held the largest artifacts in the package for the rest of the
    // verification.
    scanTable(packageDir, file, () => (row) => {
      const code = row[column] ?? '';
      if (isReasonCode(code)) return;
      fail('reasonCodes.registered', `${file} uses "${code}", which is not in the reason code registry`);
    });
  }
  for (const merge of merges) {
    for (const conflict of merge.conflicts ?? []) {
      if (!isReasonCode(conflict.reasonCode)) {
        fail('reasonCodes.registered', `merges.json conflict uses unregistered reason code "${conflict.reasonCode}"`);
      }
    }
    for (const decision of merge.fieldDecisions ?? []) {
      if (!isReasonCode(decision.reasonCode)) {
        fail('reasonCodes.registered', `merges.json decision uses unregistered reason code "${decision.reasonCode}"`);
      }
    }
  }

  // ------------------------------------------------- every artifact is counted
  mark('before the artifact counts');
  record('artifacts.countsAgree');
  const tableCounts: [string, number, string][] = [
    ['flags.csv', reconciliation.cells.flagged, 'flagged fields'],
    ['unmapped-fields.csv', reconciliation.cells.unmappedPreserved, 'preserved unmapped values'],
    ['destination-conflicts.csv', reconciliation.destination.keyConflicts, 'destination key conflicts'],
    ['formula-risk.csv', reconciliation.destination.spreadsheetFormulaRiskValues, 'formula-risk values'],
    [
      'instance-verification.csv',
      reconciliation.destination.instanceVerificationItems,
      'instance verification items',
    ],
  ];
  for (const [file, expected, label] of tableCounts) {
    if (!listed.has(file)) continue;
    const actual = countTableRows(packageDir, file);
    if (actual !== expected) {
      fail('artifacts.countsAgree', `${file} holds ${String(actual)} rows but the reconciliation counts ${String(expected)} ${label}`);
    }
  }
  // duplicate-candidates.csv, read once and nothing table-sized kept.
  //
  // Three checks want something out of it: how many clusters it holds, how many
  // source rows it names, and — much later — which migration keys each cluster
  // is made of, so the cluster id can be recomputed from them.
  //
  // The previous version of this held all three answers in memory at once and
  // said in its own comment that the surviving one was "a fraction of the
  // table". It was not. `clusterMembers` carried **every** migration key in the
  // table, `rowIds` carried every row locator beside it, and both are
  // proportional to a table that is itself proportional to how much the
  // customer's data collides with itself. On the SHEET_COUNT profile, whose ten
  // mapped sheets carry the same source ids, that table has a row per record.
  //
  // All three are answered from the order the table is already in.
  // `duplicate-candidates.csv` is written sorted by cluster id and then
  // migration key, so a cluster's rows are contiguous: counting clusters needs
  // the previous id and nothing else, and recomputing a cluster id needs the
  // keys of one cluster, released when the next one starts. What is held is the
  // largest cluster rather than the table.
  //
  // The distinct source rows are the one answer the order does not give, because
  // a row may appear in several clusters and the clusters are not grouped by
  // row. That count is taken the way this verifier takes every other count over
  // an unordered column: spilled, sorted and grouped, which holds one key at a
  // time.
  let candidateClusters = 0;
  let candidateRows = 0;
  // Filled and drained one cluster at a time by the scan below.
  const clusterProblems: string[] = [];
  {
    const rowLocators = openKeyedSpill<Record<string, never>>(scratch, 'verify-duplicate-rows');
    let currentCluster: string | null = null;
    let signal = '';
    let signalValue = '';
    let keys: string[] = [];
    const closeCluster = (): void => {
      if (currentCluster === null) return;
      const expected = clusterIdFor(signal, signalValue, keys);
      if (currentCluster !== expected) {
        clusterProblems.push(
          `duplicate cluster ${currentCluster} does not follow from the signal and records it names, which give ${expected}`,
        );
      }
      keys = [];
    };
    scanTable(packageDir, 'duplicate-candidates.csv', () => (row) => {
      const clusterId = row['cluster_id'] ?? '';
      rowLocators.add({ k: row['row_locator_id'] ?? '', v: {} });
      if (clusterId !== currentCluster) {
        closeCluster();
        currentCluster = clusterId;
        signal = row['signal'] ?? '';
        signalValue = row['signal_value'] ?? '';
        candidateClusters += 1;
      }
      keys.push(row['migration_key'] ?? '');
    });
    closeCluster();
    // Key-ordered, so distinct is a change of key. One string held.
    let previousLocator: string | null = null;
    for (const entry of rowLocators.seal()) {
      if (entry.k === previousLocator) continue;
      previousLocator = entry.k;
      candidateRows += 1;
    }
  }
  if (candidateClusters !== reconciliation.identity.duplicateCandidateClusters) {
    fail(
      'artifacts.countsAgree',
      `duplicate-candidates.csv holds ${String(candidateClusters)} clusters but the reconciliation counts ${String(reconciliation.identity.duplicateCandidateClusters)}`,
    );
  }
  const mergeConflictTotal = merges.reduce((sum, merge) => sum + (merge.conflicts ?? []).length, 0);
  if (mergeConflictTotal !== reconciliation.identity.mergeConflicts) {
    fail(
      'artifacts.countsAgree',
      `merges.json records ${String(mergeConflictTotal)} conflicts but the reconciliation counts ${String(reconciliation.identity.mergeConflicts)}`,
    );
  }
  const consentTotal = merges.reduce(
    (sum, merge) => sum + (merge.conflicts ?? []).filter((conflict) => conflict.semanticsClass === 'CONSENT').length,
    0,
  );
  if (consentTotal !== reconciliation.identity.consentConflicts) {
    fail(
      'artifacts.countsAgree',
      `merges.json records ${String(consentTotal)} consent conflicts but the reconciliation counts ${String(reconciliation.identity.consentConflicts)}`,
    );
  }
  const absorbedTotal = merges.reduce((sum, merge) => sum + merge.absorbedRowLocatorIds.length, 0);
  if (absorbedTotal !== reconciliation.identity.absorbedRows) {
    fail(
      'artifacts.countsAgree',
      `merges.json absorbs ${String(absorbedTotal)} rows but the reconciliation counts ${String(reconciliation.identity.absorbedRows)}`,
    );
  }

  // ------------------------------------------ the manifest agrees with the data
  record('manifest.agreesWithData');
  for (const [key, expected] of [
    ['runId', reconciliation.runId],
    ['bundleId', reconciliation.bundleId],
    ['configHash', reconciliation.configHash],
    ['coreVersion', reconciliation.coreVersion],
  ] as const) {
    if (manifest[key] !== expected) {
      fail('manifest.agreesWithData', `manifest.${key} is "${String(manifest[key])}" but the reconciliation says "${expected}"`);
    }
  }
  const manifestFiles = (manifest['inputs'] ?? []) as { fileId: string; path: string; sha256: string }[];
  if (manifestFiles.length !== reconciliation.inputs.fileCount) {
    fail(
      'manifest.agreesWithData',
      `the manifest lists ${String(manifestFiles.length)} inputs but the reconciliation counts ${String(reconciliation.inputs.fileCount)}`,
    );
  }
  const inputByFileId = new Map(manifestFiles.map((file) => [file.fileId, file]));
  scanTable(packageDir, 'source-lineage.csv', () => (row) => {
    const file = inputByFileId.get(row['file_id'] ?? '');
    if (file === undefined) {
      fail('manifest.agreesWithData', `lineage row ${row['row_locator_id'] ?? ''} names file ${row['file_id'] ?? ''}, which the manifest does not list`);
      return;
    }
    if (file.sha256 !== (row['file_sha256'] ?? '') || file.path !== (row['file_path'] ?? '')) {
      fail(
        'manifest.agreesWithData',
        `lineage row ${row['row_locator_id'] ?? ''} disagrees with the manifest about ${file.fileId}`,
      );
    }
  });
  for (const artifact of artifacts) {
    if (artifact.rowCount === null || !artifact.path.endsWith('.csv')) continue;
    const actual = countTableRows(packageDir, artifact.path);
    if (actual !== artifact.rowCount) {
      fail(
        'manifest.agreesWithData',
        `${artifact.path} holds ${String(actual)} rows but the manifest says ${String(artifact.rowCount)}`,
      );
    }
  }

  // -------------------------------- the change log agrees with what was delivered
  record('changes.matchDeliveredValues');
  //
  // Three artifacts have to agree here: the change log, the lineage that says
  // which record each changed row became, and the import file that holds the
  // value. The change log is co-sorted with the lineage, so the record is read
  // from a cursor; the import files are in migration-key order, so the claims
  // are spilled in that order and the delivered records are walked past them.
  // Nothing is indexed, and the delivered rows are never held.
  //
  // A record is exempt only when merges.json actually records a merge for it.
  // Reading the exemption off a lineage row count let a tamperer manufacture it
  // by relabelling any unrelated row as a second RECORD row for that key.
  const mergedSurvivorKeys = new Set(
    merges
      .filter((merge) => merge.absorbedRowLocatorIds.length > 0)
      .map((merge) => merge.survivorMigrationKey),
  );

  const changeClaims = openKeyedSpill<{
    rowLocatorId: string;
    destinationField: string;
    reasonCode: string;
    finalValue: string;
  }>(scratch, 'verify-change-claims');
  {
    const changeKeys = cursor('changes.matchDeliveredValues/changes.csv');
    scanTable(packageDir, 'changes.csv', () => (change) => {
      const key = changeKeys.at(change)?.migrationKey ?? '';
      if (key === '') return;
      if (mergedSurvivorKeys.has(key)) return;
      changeClaims.add({
        k: key,
        v: {
          rowLocatorId: change['row_locator_id'] ?? '',
          destinationField: change['destination_field'] ?? '',
          reasonCode: change['reason_code'] ?? '',
          finalValue: change['final_value'] ?? '',
        },
      });
    });
  }
  const claims = changeClaims.seal();

  // One source row per changed record, unless a merge says otherwise.
  for (const group of coGroup(claims, recordsByKey())) {
    if (group.left.length === 0) continue;
    if (group.right.length === 1) continue;
    fail(
      'changes.matchDeliveredValues',
      `${group.key} is built from more than one source row but merges.json records no merge for it`,
    );
  }

  // What the import file actually holds for each of those records.
  for (const group of coGroup(claims, deliveredRecords())) {
    const delivered = group.right[0];
    if (delivered === undefined) continue;
    for (const claim of group.left) {
      const header = headerForField(adapter, delivered.object, claim.destinationField);
      if (header === null || !(header in delivered.row)) continue;
      // An authorized clear has no value, so the cell does not hold the change's
      // final value — it holds whatever this destination spells a clear with. The
      // expectation is derived from the reason code and the adapter rather than
      // exempting the row, so the check gets stricter rather than looser: a cell
      // that has been blanked where the contract requires the clear token now
      // fails, and so does a token that no authorized clear stands behind.
      const clearsThisField = claim.reasonCode === 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION';
      const expectedCell =
        clearsThisField && adapter.clearRepresentation.kind === 'EXPLICIT_TOKEN'
          ? adapter.clearRepresentation.token
          : claim.finalValue;
      if ((delivered.row[header] ?? '') !== expectedCell) {
        fail(
          'changes.matchDeliveredValues',
          `changes.csv says ${group.key}/${claim.destinationField} was delivered as "${expectedCell}" but the import file holds "${delivered.row[header] ?? ''}"`,
        );
      }
    }
  }

  // ------------------------------------ nothing was delivered that has no source
  record('import.everyRecordHasASourceRow');
  for (const group of coGroup(
    deliveredRecords(),
    recordsByKey(),
  )) {
    if (group.left.length === 0 || group.right.length > 0) continue;
    for (const delivered of group.left) {
      fail(
        'import.everyRecordHasASourceRow',
        `${delivered.path} delivers ${group.key}, which no source row in the lineage produced`,
      );
    }
  }

  // ------------------------------------------- delivered relationship files
  mark('before the association files');
  record('import.associationFiles');
  //
  // One relationship file at a time, and each one a merge rather than a set.
  // The ledger's delivered edges and the file's rows are spilled under the same
  // key -- the pair of association keys and the label, which is exactly what a
  // row of the file is -- and walked in step. A set of every delivered edge used
  // to stand here, and at a dense association graph that is the largest artifact
  // in the package held in memory.
  const associationPaths = new Set(
    artifacts.map((artifact) => artifact.path).filter((path) => path.includes('/associations/')),
  );
  const deliveredTypes = new Set<string>();
  scanTable(packageDir, 'associations.csv', () => (row) => {
    if ((row['disposition'] ?? '') !== 'OUTPUT') return;
    deliveredTypes.add(row['relationship_type'] ?? '');
  });

  for (const type of [...deliveredTypes].sort(compareCodeUnits)) {
    const path = `${IMPORT_AREA}/${adapter.importDirectory}/associations/${type.toLowerCase()}.csv`;
    if (!listed.has(path)) {
      fail('import.associationFiles', `${type} relationships are delivered but ${path} is missing`);
      continue;
    }
    associationPaths.delete(path);

    // The ledger, in the spelling the import file uses. The association key is
    // derived from the run id and the migration key and nothing else, so it can
    // be recomputed from the ledger as easily as it was written.
    const ledger = openKeyedSpill<{ from: string; to: string }>(scratch, `verify-ledger-${type.toLowerCase()}`);
    scanTable(packageDir, 'associations.csv', () => (row) => {
      if ((row['disposition'] ?? '') !== 'OUTPUT') return;
      if ((row['relationship_type'] ?? '') !== type) return;
      const from = importKeyFor(reconciliation.runId, row['from_migration_key'] ?? '');
      const to = importKeyFor(reconciliation.runId, row['to_migration_key'] ?? '');
      ledger.add({ k: `${from}${PAIR_SEPARATOR}${to}${PAIR_SEPARATOR}${row['label'] ?? ''}`, v: { from, to } });
    });

    const expectedHeaders = [adapter.associationFromHeader, adapter.associationToHeader, 'Association Label'];
    const written = openKeyedSpill<{ from: string; to: string }>(scratch, `verify-written-${type.toLowerCase()}`);
    const endpoints = openKeyedSpill<{ from: string; to: string }>(
      scratch,
      `verify-endpoints-${type.toLowerCase()}`,
    );
    scanTable(packageDir, path, (headers) => {
      if (headers.join(',') !== expectedHeaders.join(',')) {
        fail('import.associationFiles', `${path} headers are [${headers.join(', ')}]`);
      }
      return (row) => {
        const from = row[adapter.associationFromHeader] ?? '';
        const to = row[adapter.associationToHeader] ?? '';
        written.add({
          k: `${from}${PAIR_SEPARATOR}${to}${PAIR_SEPARATOR}${row['Association Label'] ?? ''}`,
          v: { from, to },
        });
        endpoints.add({ k: from, v: { from, to } });
        endpoints.add({ k: to, v: { from, to } });
        // The apostrophe rule is csvSafety.noValueRewriting's, and it asks
        // changes.csv whether the engine introduced one. It was duplicated here
        // with the same defect: any value beginning with an apostrophe was
        // reported as spreadsheet escaping, so an association label reading
        // "'Twas" failed a correct package, and fixing one copy would have left
        // the other failing it.
      };
    });

    for (const group of coGroup(written.seal(), ledger.seal())) {
      const row = group.left[0] ?? group.right[0];
      if (row === undefined) continue;
      if (group.left.length > 1) {
        fail('import.associationFiles', `${path} delivers the same relationship twice: ${row.from} -> ${row.to}`);
      }
      if (group.left.length > 0 && group.right.length === 0) {
        fail(
          'import.associationFiles',
          `${path} delivers ${row.from} -> ${row.to}, which the relationship ledger does not record as delivered`,
        );
      }
      if (group.left.length === 0 && group.right.length > 0) {
        fail(
          'import.associationFiles',
          `${path} is missing the delivered relationship ${row.from} -> ${row.to}`,
        );
      }
    }

    // Both ends of every written relationship are records this package
    // delivers, compared in the spelling the file uses.
    for (const group of coGroup(
      endpoints.seal(),
      (function* () {
        const keys = openKeyedSpill<null>(scratch, `verify-delivered-import-keys-${type.toLowerCase()}`);
        for (const delivered of deliveredRecords()) {
          keys.add({ k: importKeyFor(reconciliation.runId, delivered.k), v: null });
        }
        yield* keys.seal();
      })(),
    )) {
      if (group.left.length === 0 || group.right.length > 0) continue;
      const row = group.left[0];
      if (row === undefined) continue;
      fail(
        'import.associationFiles',
        `${path} delivers ${row.from} -> ${row.to}, and one of those records is in no import file`,
      );
    }
  }
  // A relationship the plan declares gets a file whether or not this dataset
  // resolved any of it, so an empty file is expected and an absent one is not.
  // What has to hold is that it really is empty: a file with rows in it and no
  // ledger entry for its type is a set of relationships nothing accounts for.
  for (const type of declaredRelationshipTypes(loaded.config)) {
    const declaredPath = `${IMPORT_AREA}/${adapter.importDirectory}/associations/${type.toLowerCase()}.csv`;
    if (deliveredTypes.has(type)) continue;
    associationPaths.delete(declaredPath);
    if (!listed.has(declaredPath)) {
      fail(
        'import.associationFiles',
        `${declaredPath} is missing although the configuration declares ${type} relationships`,
      );
      continue;
    }
    const rows = countTableRows(packageDir, declaredPath);
    if (rows !== 0) {
      fail(
        'import.associationFiles',
        `${declaredPath} holds ${String(rows)} relationships but the ledger records none of that type as delivered`,
      );
    }
  }
  for (const orphan of associationPaths) {
    fail('import.associationFiles', `${orphan} holds relationships the ledger does not record as delivered`);
  }

  // ------------------------------------------------ deduplication points somewhere
  record('associations.deduplicationPointer');
  // The pointer a deduplicated edge carries has to name a relationship this
  // package holds. That was answered from a set of every edge id -- "a set of
  // short strings", but one string per relationship, which is the ledger's index
  // in memory and at a dense graph the largest thing this check touches.
  //
  // Both sides are spilled and merged instead, and what survives the merge is
  // only the pointers that name nothing: none, in a package that verifies. The
  // set below is therefore bounded by the failures rather than by the ledger.
  //
  // Nothing is spilled at all where nothing was deduplicated, which is the
  // common case: the count below is a streamed pass that keeps no row, and a
  // ledger with no deduplicated edge carrying a pointer has no question to ask.
  // That matters because scratch is a budget too, and spending the ledger's
  // worth of it to answer nothing would move the cost rather than remove it.
  let deduplicatedPointers = 0;
  scanTable(packageDir, 'associations.csv', () => (row) => {
    if ((row['disposition'] ?? '') !== 'DEDUPLICATED') return;
    if ((row['deduplicated_into_edge_id'] ?? '') === '') return;
    deduplicatedPointers += 1;
  });
  const danglingPointers = new Set<string>();
  if (deduplicatedPointers > 0) {
    // The pointer travels as the record, because the set below is asked about
    // the raw text of a cell in the pass after this one, and a key is escaped.
    const targets = openKeyedSpill<string>(scratch, 'verify-deduplication-targets');
    const ids = openKeyedSpill<null>(scratch, 'verify-edge-ids');
    scanTable(packageDir, 'associations.csv', () => (row) => {
      ids.add({ k: row['source_edge_id'] ?? '', v: null });
      if ((row['disposition'] ?? '') !== 'DEDUPLICATED') return;
      const target = row['deduplicated_into_edge_id'] ?? '';
      if (target === '') return;
      targets.add({ k: target, v: target });
    });
    for (const group of coGroup(targets.seal(), ids.seal())) {
      if (group.left.length === 0 || group.right.length > 0) continue;
      danglingPointers.add(group.left[0] ?? group.key);
    }
  }
  scanTable(packageDir, 'associations.csv', () => (row) => {
    const target = row['deduplicated_into_edge_id'] ?? '';
    if ((row['disposition'] ?? '') === 'DEDUPLICATED') {
      if (target === '') {
        fail('associations.deduplicationPointer', `edge ${row['source_edge_id'] ?? ''} is deduplicated but names no surviving relationship`);
      } else if (danglingPointers.has(target)) {
        fail('associations.deduplicationPointer', `edge ${row['source_edge_id'] ?? ''} points at ${target}, which is not a relationship in this package`);
      }
    } else if (target !== '') {
      fail('associations.deduplicationPointer', `edge ${row['source_edge_id'] ?? ''} names a surviving relationship but is not deduplicated`);
    }
  });

  // ------------------------------------------- only expected artifacts exist
  record('manifest.noUnexpectedArtifacts');
  // Every artifact a package of this format holds, at the address the layout
  // gives it. An artifact in the right area under the wrong name, or the right
  // name in the wrong area, is an unexpected file either way: the operator is
  // told to import one directory and nothing else, so what is in that
  // directory has to be exactly what this configuration produces.
  const expectedPaths = new Set<string>(
    [
      'reconciliation.json',
      'config.normalized.json',
      'source-lineage.csv',
      'import-crosswalk.csv',
      'changes.csv',
      'flags.csv',
      'unmapped-fields.csv',
      'isolated.csv',
      'leftovers.csv',
      'rejected-input.csv',
      'duplicate-candidates.csv',
      'associations.csv',
      'unresolved-associations.csv',
      'destination-conflicts.csv',
      'formula-risk.csv',
      'instance-verification.csv',
      'destination-matching.csv',
      'merges.json',
      'audit.md',
      'import-instructions.md',
    ].map((name) => packagePath(name)),
  );
  for (const mappingObject of uniqueObjects(loaded.config)) {
    const spec = objectSpec(adapter, mappingObject.object);
    if (spec === null) continue;
    // The base name, or the parts it was cut into. `importPartsListed` has
    // already refused a listing that is neither — a base name beside numbered
    // parts, a single numbered part, a gap in the numbering — so what it returns
    // here is a set that was accounted for rather than one read off the disk. A
    // stray part outside that set falls through to the refusal below.
    const base = `${IMPORT_AREA}/${adapter.importDirectory}/${spec.fileName}`;
    const parts = importPartsListed(base, listed);
    if (parts.paths.length === 0) expectedPaths.add(base);
    for (const path of parts.paths) expectedPaths.add(path);
  }
  // One association file per relationship the configuration declares, whether
  // or not this dataset resolved any. Deriving the set from the edges that came
  // out would mean the expected file set depended on the data, so a package
  // missing an entire relationship would look complete.
  for (const type of declaredRelationshipTypes(loaded.config)) {
    expectedPaths.add(`${IMPORT_AREA}/${adapter.importDirectory}/associations/${type.toLowerCase()}.csv`);
  }
  // The human data view of every import file that holds a cell a spreadsheet
  // would execute, and of no other (D72). Which files those are is read from the
  // import files, never from the manifest.
  const importCsvPaths = artifacts
    .map((artifact) => artifact.path)
    .filter((path) => path.startsWith(`${IMPORT_AREA}/`) && path.endsWith('.csv'));
  const riskyImports = new Set<string>();
  for (const path of importCsvPaths) {
    if (importFileHasRiskyCell(packageDir, path)) {
      riskyImports.add(path);
      expectedPaths.add(dataViewPathFor(path));
    }
  }
  for (const artifact of artifacts) {
    if (!expectedPaths.has(artifact.path)) {
      fail(
        'manifest.noUnexpectedArtifacts',
        `${artifact.path} is not an artifact this configuration and destination produce`,
      );
    }
  }

  // ------------------------------------------ the human view (D72, R2-010)
  //
  // A machine file is exact and a human view never executes. Four claims, each
  // settled from the bytes: every artifact declares the kind its path has; an
  // import file with a risky cell has a view and only those do; a view is its
  // import file with exactly the risky cells neutralised, derived here from the
  // import file; and no cell of any human view begins like a formula.
  record('humanView.kindDeclared');
  for (const artifact of artifacts) {
    let expected: string;
    try {
      expected = artifactKind(artifact.path);
    } catch {
      continue; // a CSV the layout does not place is refused as unexpected above
    }
    if (artifact.kind !== expected) {
      fail(
        'humanView.kindDeclared',
        `${artifact.path} declares kind ${JSON.stringify(artifact.kind ?? null)} and a file at that path is ${expected}`,
      );
    }
  }

  record('humanView.presence');
  const listedArtifactPaths = new Set(artifacts.map((artifact) => artifact.path));
  for (const path of importCsvPaths) {
    const view = dataViewPathFor(path);
    if (riskyImports.has(path) && !listedArtifactPaths.has(view)) {
      fail('humanView.presence', `${path} holds a cell a spreadsheet would execute and the package has no human data view at ${view}`);
    }
    if (!riskyImports.has(path) && listedArtifactPaths.has(view)) {
      fail('humanView.presence', `${view} is a data view of ${path}, which holds nothing to neutralise`);
    }
  }
  for (const artifact of artifacts) {
    const source = importPathForDataView(artifact.path);
    if (source !== null && !listedArtifactPaths.has(source)) {
      fail('humanView.presence', `${artifact.path} is a data view of ${source}, which this package does not hold`);
    }
  }

  record('humanView.matchesImport');
  for (const path of importCsvPaths) {
    const view = dataViewPathFor(path);
    if (!listedArtifactPaths.has(view)) continue;
    compareViewWithImport(packageDir, path, view, fail);
  }

  record('humanView.noExecutableCell');
  for (const artifact of artifacts) {
    let expected: string;
    try {
      expected = artifactKind(artifact.path);
    } catch {
      continue;
    }
    if (expected !== 'HUMAN_VIEW_CSV') continue;
    assertNoExecutableCell(packageDir, artifact.path, fail);
  }

  // ------------------------------------- the reason code tally is not a claim
  record('reconciliation.reasonCodeTally');
  const observedTally = new Map<string, number>();
  const countCode = (code: string): void => {
    if (code === '') return;
    observedTally.set(code, (observedTally.get(code) ?? 0) + 1);
  };
  for (const [file, column] of [
    ['source-lineage.csv', 'reason_code'],
    ['changes.csv', 'reason_code'],
    ['flags.csv', 'reason_code'],
    ['associations.csv', 'reason_code'],
    ['duplicate-candidates.csv', 'reason_code'],
    ['destination-conflicts.csv', 'reason_code'],
  ] as const) {
    if (!listed.has(file)) continue;
    // Streamed. This read the lineage and the change log whole, and the cache
    // then held both for the rest of the verification -- to count one column.
    scanTable(packageDir, file, () => (row) => countCode(row[column] ?? ''));
  }
  const declaredTally = reconciliation.reasonCodeTally as unknown as Record<string, number>;
  for (const [code, total] of observedTally) {
    if ((declaredTally[code] ?? 0) !== total) {
      fail(
        'reconciliation.reasonCodeTally',
        `${code} appears ${String(total)} times in the artifacts but the reconciliation counts ${String(declaredTally[code] ?? 0)}`,
      );
    }
  }
  for (const [code, total] of Object.entries(declaredTally)) {
    if ((observedTally.get(code) ?? 0) !== total) {
      fail(
        'reconciliation.reasonCodeTally',
        `the reconciliation counts ${code} ${String(total)} times but the artifacts hold ${String(observedTally.get(code) ?? 0)}`,
      );
    }
  }
  // ------------------------------------------- a merge survivor carries the record
  mark('before the merge survivors');
  record('merges.survivorDisposition');
  // Two questions about each survivor: what the lineage says it is, and whether
  // an import file holds it. Both are answered by walking spilled projections in
  // step rather than by indexing the lineage or the delivered records.
  const survivorRows = spillKeyed(
    scratch,
    'verify-merge-survivor-rows',
    (function* () {
      for (const merge of merges) {
        yield { k: merge.survivorRowLocatorId, v: { mergeId: merge.mergeId, migrationKey: merge.survivorMigrationKey } };
      }
    })(),
  );
  const survivorsToDeliver: { mergeId: string; migrationKey: string }[] = [];
  for (const group of coGroup(survivorRows, lineageByLocator())) {
    const facts = group.right[0] ?? null;
    for (const survivor of group.left) {
      const disposition = facts?.disposition;
      if (disposition !== 'OUTPUT' && disposition !== 'ISOLATED') {
        fail(
          'merges.survivorDisposition',
          `merge ${survivor.mergeId} survives on ${group.key}, whose disposition is ${disposition === undefined ? 'undefined' : disposition}; a survivor is delivered or set aside, never anything else`,
        );
      }
      if (disposition === 'OUTPUT') survivorsToDeliver.push(survivor);
    }
  }
  // Bounded by the number of merges whose survivor is delivered, which is what
  // this check is about; the delivered records themselves stay a stream.
  for (const group of coGroup(
    spillKeyed(
      scratch,
      'verify-merge-survivor-keys',
      survivorsToDeliver.map((survivor) => ({ k: survivor.migrationKey, v: survivor })),
    ),
    deliveredRecords(),
  )) {
    if (group.right.length > 0) continue;
    for (const survivor of group.left) {
      fail(
        'merges.survivorDisposition',
        `merge ${survivor.mergeId} claims to deliver ${survivor.migrationKey}, which is in no import file`,
      );
    }
  }

  // ---------------------------- a record set aside for a conflict is not delivered
  record('destination.conflictsAreNotDelivered');
  //
  // Everything below is bounded by the number of destination key conflicts, not
  // by the number of records. The three questions a conflict raises -- was this
  // key produced, was it delivered, was it set aside -- used to be answered from
  // three sets built over every source row. They are answered here by spilling
  // the conflicted keys, which are few, and walking each of the three larger
  // artifacts past them once.
  //
  // That sentence was false until this edit, and it was false in the way that
  // matters: `note(group.key)` inside the two walks below. `coGroup` yields a
  // group for every key on *either* side, so on a package with no conflicts --
  // where the conflicted family is empty and every group is a record with
  // nothing opposite it -- the map that is "bounded by the number of destination
  // key conflicts" gained an entry per delivered migration key. Nothing read
  // those entries: every later loop skips what is not `named`, and only
  // `destination-conflicts.csv` names anything. So it was pure retention, and
  // it was the whole of this verification's growth with the row count.
  //
  // Measured with `tools/verifier-memory-probe.mjs` on 2026-09-04, one package
  // and two verifiers differing in these two lines: peak retained heap over the
  // verification fell from 5,700,840 to 1,664,152 bytes at 30,000 source rows
  // and from 13,363,064 to 1,296,840 at 120,000 -- an 85-bytes-per-row slope
  // replaced by no slope -- with the same 55 checks and the same verdict on all
  // 42 packages of the golden and adversarial corpora.
  //
  // What is noted is the record the spill carried rather than the key it
  // grouped under, because a key here is escaped and this map is also read by
  // keys that were never spilled.
  interface ConflictedKey {
    named: boolean;
    produced: boolean;
    delivered: boolean;
    isolated: boolean;
  }
  const conflicted = new Map<string, ConflictedKey>();
  const note = (key: string): ConflictedKey => {
    const held = conflicted.get(key);
    if (held !== undefined) return held;
    const fresh = { named: false, produced: false, delivered: false, isolated: false };
    conflicted.set(key, fresh);
    return fresh;
  };

  scanTable(packageDir, 'destination-conflicts.csv', () => (row) => {
    const keys = (row['migration_keys'] ?? '').split(' ').filter((value) => value.length > 0);
    if (keys.length < 2) {
      fail('destination.conflictsAreNotDelivered', 'a destination conflict names fewer than two records');
    }
    for (const key of keys) note(key).named = true;
  });

  // Which records were set aside for a conflict, read from the isolated list
  // alongside the lineage that says what each isolated row became.
  const conflictIsolatedKeys = new Set<string>();
  {
    const isolatedLineage = cursor('destination.conflictsAreNotDelivered/isolated.csv');
    scanTable(packageDir, 'isolated.csv', () => (row) => {
      const key = isolatedLineage.at(row)?.migrationKey ?? '';
      if (key === '') return;
      note(key).isolated = true;
      if ((row['reason_code'] ?? '') === 'DESTINATION_KEY_CONFLICT') conflictIsolatedKeys.add(key);
    });
  }

  const conflictedKeys = spillKeyed(
    scratch,
    'verify-conflicted-keys',
    [...conflicted.keys()].map((key) => ({ k: key, v: key })),
  );
  // Only the keys the conflicted family carried are noted -- see above.
  for (const group of coGroup(conflictedKeys, recordsByKey())) {
    if (group.right.length === 0) continue;
    for (const key of group.left) note(key).produced = true;
  }
  for (const group of coGroup(conflictedKeys, deliveredRecords())) {
    if (group.right.length === 0) continue;
    for (const key of group.left) note(key).delivered = true;
  }

  for (const [key, state] of conflicted) {
    if (!state.named) continue;
    if (!state.produced) {
      fail(
        'destination.conflictsAreNotDelivered',
        `a destination conflict names ${key}, which no source row produced`,
      );
    }
    // Every record named in a conflict is either delivered or set aside. A key
    // that is neither has been quietly dropped.
    //
    // Not "set aside *for that conflict*": a record already isolated for an
    // earlier reason keeps that reason, so demanding this one refused correct
    // packages. And not "at most one delivered": under
    // DELIVER_WITH_ALTERNATE_KEY the destination tells them apart by another
    // key, so delivering all of them is the whole point of the policy.
    if (!state.delivered && !state.isolated) {
      fail(
        'destination.conflictsAreNotDelivered',
        `${key} is named in a destination key conflict but is neither delivered nor set aside`,
      );
    }
  }

  // These two run whether or not the conflict table has rows. Reading the
  // policy out of the configuration under test let an edited policy switch the
  // check off, and putting the checks inside the loop let an emptied table do
  // the same. The witness is now the reason codes the package actually used.
  if (conflictIsolatedKeys.size > 0) {
    for (const [key, state] of conflicted) {
      if (!state.named || !state.delivered) continue;
      fail(
        'destination.conflictsAreNotDelivered',
        `${key} was delivered although this package sets records aside for destination key conflicts`,
      );
    }
    for (const key of conflictIsolatedKeys) {
      if (conflicted.get(key)?.named === true) continue;
      fail(
        'destination.conflictsAreNotDelivered',
        `${key} was set aside for a destination key conflict that destination-conflicts.csv does not record`,
      );
    }
  }
  if (loaded.config.policies.destinationKeyConflict === 'ISOLATE') {
    for (const [key, state] of conflicted) {
      if (!state.named || !state.delivered) continue;
      fail(
        'destination.conflictsAreNotDelivered',
        `${key} is named in a destination key conflict but was delivered anyway, which is the silent merge the policy exists to prevent`,
      );
    }
  }
  // -------------------------------- the formula warning names the actual values
  mark('before the risk values');
  record('csvSafety.riskValuesMatch');

  /**
   * formula-risk.csv, read once and spilled, rather than read three times into
   * three sets that grow with the data.
   *
   * There is one row here per delivered cell a spreadsheet would read as a
   * formula, and the engine's own phone transform emits E.164 — which always
   * begins with a plus. So on any ordinary contact migration this file holds one
   * row per phone number: at a million contacts with two phone columns, two
   * million rows. It was parsed whole three times (the per-verification cache
   * the surrounding comment describes has no constructor and is never
   * instantiated), and the three parses built a Set of `key|field|value`, a Set
   * of `key|value`, and a Map from label to edge ids that was rebuilt inside the
   * loop over association files.
   *
   * Now it is streamed once into two spilled projections — by the key it names
   * and by the value it declares — and every question below is a walk over two
   * sorted families in step. What is held at any moment is one key's worth of
   * rows.
   *
   * Multiplicity is preserved, which the Sets destroyed: two rows declaring the
   * same risk are two rows here, so a package that declares one twice is visible
   * instead of smoothed into one.
   */
  const declaredByKey = openKeyedSpill<{ field: string; value: string }>(scratch, 'verify-declared-risk-by-key');
  // formula-risk.csv is a human view: its value column is the neutralised value
  // and value_sha256 names the exact one. The exact value is recovered here,
  // proved against the digest, and only that is compared with the import files.
  let riskDigestProblems = 0;
  scanTable(packageDir, 'formula-risk.csv', () => (row) => {
    const shown = row['value'] ?? '';
    const exact = shown.startsWith("'") ? shown.slice(1) : shown;
    if (sha256Hex(exact) !== (row['value_sha256'] ?? '') || !startsLikeFormula(exact)) {
      riskDigestProblems += 1;
      if (riskDigestProblems <= REPORTED_EXAMPLES) {
        fail(
          'humanView.valueDigest',
          `formula-risk.csv row for ${row['migration_key'] ?? ''}|${row['destination_field'] ?? ''} does not name a formula-like value its value_sha256 proves`,
        );
      }
    }
    declaredByKey.add({
      k: row['migration_key'] ?? '',
      v: { field: row['destination_field'] ?? '', value: exact },
    });
  });
  if (riskDigestProblems > REPORTED_EXAMPLES) {
    fail('humanView.valueDigest', `${String(riskDigestProblems)} formula-risk.csv rows fail their digest in total; the first ${String(REPORTED_EXAMPLES)} are named above`);
  }
  const declaredByKeyFamily = declaredByKey.seal();

  // Every relationship the ledger holds, projected to its id and its label and
  // spilled. Reading it into a Map was one entry per edge; spilling it is one
  // edge at a time, and the walk below sees each declared key beside the edge it
  // may name.
  const edgeLabels = openKeyedSpill<{ label: string }>(scratch, 'verify-edge-labels');
  scanTable(packageDir, 'associations.csv', () => (row) => {
    edgeLabels.add({ k: row['source_edge_id'] ?? '', v: { label: row['label'] ?? '' } });
  });

  // A declared risk names either an edge or a delivered record. The first walk
  // settles the edges and hands the rest on, so nothing has to remember which
  // keys were edges.
  let declaredForRecords = 0;
  let riskProblems = 0;
  const declaredForRecordValues = openKeyedSpill<{ field: string; value: string }>(scratch, 'verify-declared-risk-records');
  // The values an edge is declared to carry, and does carry. Emitted here so the
  // association files below can be checked against the edges that actually hold
  // the value rather than against the value appearing anywhere in the file.
  const validatedEdgeValues = openKeyedSpill<{ edgeId: string }>(scratch, 'verify-edge-risk-values');
  for (const group of coGroup(declaredByKeyFamily, edgeLabels.seal())) {
    if (group.left.length === 0) continue;
    const edge = group.right[0];
    for (const claim of group.left) {
      if (edge !== undefined) {
        if (edge.label !== claim.value) {
          riskProblems += 1;
          if (riskProblems <= REPORTED_EXAMPLES) {
            fail(
              'csvSafety.riskValuesMatch',
              `formula-risk.csv names a label edge ${group.key} does not carry: ${claim.value}`,
            );
          }
          continue;
        }
        validatedEdgeValues.add({ k: claim.value, v: { edgeId: group.key } });
        continue;
      }
      declaredForRecords += 1;
      declaredForRecordValues.add({ k: group.key, v: claim });
    }
  }

  // The record-scoped claims against the records themselves.
  for (const group of coGroup(declaredForRecordValues.seal(), deliveredRecords())) {
    if (group.left.length === 0) continue;
    const delivered = group.right[0];
    for (const claim of group.left) {
      if (delivered !== undefined && Object.values(delivered.row).includes(claim.value)) continue;
      riskProblems += 1;
      if (riskProblems <= REPORTED_EXAMPLES) {
        fail(
          'csvSafety.riskValuesMatch',
          `formula-risk.csv names a value the import files do not hold: ${group.key}|${claim.field}|${claim.value}`,
        );
      }
    }
  }

  // The delivered side, counted rather than collected.
  //
  // `observedRiskValues` was a Set of `key|field|value` over every formula-like
  // delivered cell — the single largest structure in this verification once
  // E.164 is in play, and the comment above it claimed it was "bounded by how
  // many such values a package holds … rather than by how many records it
  // delivers", which are the same number when the values are phone numbers.
  let observedRiskCells = 0;
  for (const delivered of deliveredRecords()) {
    const canonical = importColumnsFor(adapter, loaded.config, delivered.v.object);
    for (const fieldName of Object.keys(delivered.v.row)) {
      if (!canonical.includes(fieldName)) continue;
      if (!startsLikeFormula(delivered.v.row[fieldName] ?? '')) continue;
      observedRiskCells += 1;
    }
  }

  // The association files, joined on the value rather than searched per cell.
  //
  // This built a label-to-edge-ids Map by scanning the whole relationship ledger
  // *inside* the loop over association files, so a package delivering four kinds
  // of relationship read its largest artifact four times, and one repeated label
  // put every edge id into one array.
  const associationRiskCells = openKeyedSpill<{ path: string }>(scratch, 'verify-association-risk-cells');
  for (const artifact of artifacts) {
    if (!artifact.path.startsWith(`${IMPORT_AREA}/${adapter.importDirectory}/associations/`)) continue;
    scanTable(packageDir, artifact.path, (headers) => (row) => {
      for (const header of headers) {
        const value = row[header] ?? '';
        if (!startsLikeFormula(value)) continue;
        associationRiskCells.add({ k: value, v: { path: artifact.path } });
      }
    });
  }
  // Against the edges that carry the value, not against the value existing
  // somewhere in the file.
  //
  // The first version of this rewrite joined the association cells against every
  // declared risk row on the value alone, so a label `=HYPERLINK(...)` delivered
  // on edge E-002 was accepted because some *record* elsewhere had been declared
  // with the same text. The engine emits an association risk under the edge id,
  // so the edge-scoped form is the one that means anything, and it is what the
  // walk above has already validated.
  for (const group of coGroup(validatedEdgeValues.seal(), associationRiskCells.seal())) {
    if (group.right.length === 0) continue;
    if (group.left.length > 0) continue;
    const where = group.right[0];
    riskProblems += 1;
    if (riskProblems <= REPORTED_EXAMPLES) {
      fail(
        'csvSafety.riskValuesMatch',
        `${where === undefined ? 'an association file' : where.path} delivers a value a spreadsheet reads as a formula, and ` +
          'no edge that formula-risk.csv declares carries it',
      );
    }
  }
  if (riskProblems > REPORTED_EXAMPLES) {
    fail(
      'csvSafety.riskValuesMatch',
      `${String(riskProblems)} risk mismatches in total; the first ${String(REPORTED_EXAMPLES)} are named above`,
    );
  }

  if (declaredForRecords !== observedRiskCells) {
    fail(
      'csvSafety.riskValuesMatch',
      `${String(observedRiskCells)} delivered values begin like a formula but formula-risk.csv names ${String(declaredForRecords)}`,
    );
  }

  // -------------------------- the unresolved list refers to real relationships
  record('associations.unresolvedAreReal');
  // The two sides spilled and walked in step, rather than one indexed.
  //
  // "One short string per edge" was still one entry per edge: at a dense
  // association graph `associations.csv` is the largest artifact in the package
  // and this held its index -- an id and a disposition for every relationship --
  // for the whole check. Both artifacts are projected down to what the question
  // needs, spilled through the host's scratch store in one order, and merged.
  // What is held is one edge id's worth of rows.
  //
  // Every disposition the ledger records for an id is tested, not just the
  // first. A repeated edge id is `associations.partition`'s failure to report,
  // but choosing one of the two rows to read here would be a way to hide a
  // delivered relationship behind a duplicate of an unresolved one.
  //
  // Nothing is spilled where the unresolved list is empty, which is the common
  // case: the ledger's worth of scratch would be spent answering no question,
  // and scratch is a budget the same way the heap is.
  if (countTableRows(packageDir, 'unresolved-associations.csv') > 0) {
    const named = openKeyedSpill<string>(scratch, 'verify-unresolved-named');
    scanTable(packageDir, 'unresolved-associations.csv', () => (row) => {
      const id = row['source_edge_id'] ?? '';
      named.add({ k: id, v: id });
    });
    const ledger = openKeyedSpill<string>(scratch, 'verify-edge-dispositions');
    scanTable(packageDir, 'associations.csv', () => (row) => {
      ledger.add({ k: row['source_edge_id'] ?? '', v: row['disposition'] ?? '' });
    });
    for (const group of coGroup(named.seal(), ledger.seal())) {
      if (group.left.length === 0) continue;
      for (const id of group.left) {
        if (group.right.length === 0) {
          fail('associations.unresolvedAreReal', `unresolved-associations.csv names ${id}, which is not a relationship in this package`);
          continue;
        }
        for (const disposition of group.right) {
          if (disposition === 'UNRESOLVED' || disposition === 'LEFTOVER') continue;
          fail(
            'associations.unresolvedAreReal',
            `unresolved-associations.csv names ${id}, whose disposition in the ledger is ${disposition}`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------- audit.md
  // ------------------------------------------------- one row per thing
  // ---------------------------- the bytes are the bytes the renderer declares
  record('artifacts.canonicalBytes');
  // A package that claims byte-reproducibility has to have bytes that can be
  // reproduced. A prepended BOM, CRLF line endings and re-quoted fields all
  // read back as the same table through a tolerant reader, so a check that
  // parses first can never see them.
  //
  // This loop is the widest sweep the verification makes: it visits every CSV in
  // the package. It compared a line at a time, which bounded what it *held* --
  // but it still began with `readFileSync` and `toString('utf8')`, so a Buffer
  // and a string, each proportional to the artifact, were allocated before the
  // first line was compared. At a million rows `unmapped-fields.csv` is 424 MB
  // on disk and about a gigabyte across those two representations, for an
  // artifact no other check reads. Bounding what is kept while allocating the
  // whole file is not bounded; resident memory does not come back.
  //
  // ---- why two digests and two lengths answer exactly the same question ----
  //
  // The engine writes a CSV as its header line and one line per record, each
  // field escaped, joined by newlines, with a trailing newline. Call the file's
  // bytes F, and C the concatenation of `escapeField`-rendered lines the reader's
  // own records imply. The old comparison asked, position by position, whether
  // F = C. This asks whether SHA-256(F) = SHA-256(C) and |F| = |C|, feeding both
  // sides a block at a time and keeping one block and one line.
  //
  // Equal digest and equal length is byte equality: distinct byte strings of
  // equal length with one SHA-256 digest is a collision, and none is known. The
  // length is carried separately rather than trusted to the digest because it
  // is the cheap, independent witness -- a truncation or an appended trailer is
  // caught by arithmetic before any cryptography is relied on, and a file whose
  // last line lacks its terminator differs from C by exactly one byte.
  //
  // Comparing bytes rather than decoded text also makes this strictly stronger
  // in one place: an invalid UTF-8 sequence decoded to U+FFFD, and the old
  // comparison then matched that replacement character against itself and
  // called the file canonical. Here the file's own bytes hold 0xFF and the
  // rendering holds EF BF BD, so the digests part and so do the lengths.
  for (const artifact of artifacts) {
    if (!artifact.path.endsWith('.csv')) continue;

    // What the file says, and what this engine would have written for it. Both
    // are accumulated as the same blocks go past, so neither ever exists whole.
    const fileDigest = createHash('sha256');
    const renderedDigest = createHash('sha256');
    let fileBytes = 0;
    let renderedBytes = 0;
    let headers: readonly string[] | null = null;
    let records = 0;
    let bom = false;

    // A scan for CRLF anywhere in the file also matched a properly quoted
    // delivered value holding one — a multi-line address typed on Windows —
    // and aborted the run. The rendering below covers the real case: a file
    // whose *line endings* are CRLF does not match the bytes this engine
    // writes, and neither does one whose fields have been re-quoted.
    //
    // The same reader ingest uses, fed in pieces. There is deliberately not a
    // second parser here: two parsers would be two definitions of what a CSV
    // is, and this one would eventually disagree with the one that wrote the
    // file it is judging.
    const scanner = createCsvScanner({ ...CSV_LIMITS, filePath: artifact.path }, (_recordNumber, fields) => {
      records += 1;
      if (headers === null) headers = [...fields];

      // Addressed by header name, not by position, so that a file repeating a
      // header is re-rendered the way the reader resolves it — the last column
      // of that name winning, in both columns. Rendering the raw fields instead
      // would reproduce any line as itself and the check would pass on
      // everything.
      const named: Record<string, string> = {};
      headers.forEach((name, index) => {
        named[name] = fields[index] ?? '';
      });
      const line = headers.map((name) => escapeField(named[name] ?? '')).join(',');
      // Encoded here rather than compared as text: the file is bytes, and the
      // question is whether these are those bytes. One line, whatever the
      // artifact weighs.
      const rendered = Buffer.from(`${line}\n`, 'utf8');
      renderedDigest.update(rendered);
      renderedBytes += rendered.length;
    });

    // Opened rather than read: an artifact missing from the package is
    // `manifest.artifactHashes`'s failure to report, and it has already run.
    let opened: number | null = null;
    try {
      opened = openSync(join(packageDir, ...artifact.path.split('/')), 'r');
    } catch {
      opened = null;
    }
    if (opened === null) continue;
    const handle = opened;
    const buffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
    // Incremental, and it has to be: a multi-byte character can land across a
    // block boundary, and a decoder that finished at every boundary would turn
    // one character into two replacement characters at a position that depends
    // on the block size.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    try {
      for (;;) {
        const read = readSync(handle, buffer, 0, buffer.length, null);
        if (read === 0) break;
        // Three bytes at the very start of the file, so the only block that can
        // carry the mark is the first. Reported before parsing, as it was: the
        // decoder swallows a leading BOM, and a file that carries one has a
        // specific thing wrong with it that deserves to be named.
        if (fileBytes === 0 && read >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
          bom = true;
          break;
        }
        fileDigest.update(buffer.subarray(0, read));
        fileBytes += read;
        // `stream: true` keeps any partial character for the next block.
        scanner.push(decoder.decode(buffer.subarray(0, read), { stream: true }));
      }
      if (!bom) {
        // The final call without `stream` flushes anything the file ended
        // mid-way through, so a truncated character is rendered rather than
        // dropped — and a rendering that differs from the file is what this
        // check exists to notice.
        scanner.push(decoder.decode());
        scanner.end();
      }
    } finally {
      closeSync(handle);
    }

    if (bom) {
      fail('artifacts.canonicalBytes', `${artifact.path} begins with a byte order mark, which this format does not carry`);
      continue;
    }

    // A file the reader finds no records in renders as nothing at all and would
    // compare equal to the empty file it is, which is the one case a rendering
    // comparison lets through and a whole-file comparison caught. Every artifact
    // this format defines carries at least a header line.
    const canonical =
      records > 0 && renderedBytes === fileBytes && renderedDigest.digest('hex') === fileDigest.digest('hex');

    if (!canonical) {
      fail(
        'artifacts.canonicalBytes',
        `${artifact.path} is not written the way this engine writes a CSV, so its bytes were produced or edited by something else`,
      );
    }
  }

  record('import.fileConstraints');
  for (const artifact of artifacts) {
    if (!artifact.path.startsWith(`${IMPORT_AREA}/${adapter.importDirectory}/`)) continue;
    if (artifact.byteLength > adapter.fileConstraints.maxFileBytes) {
      fail(
        'import.fileConstraints',
        `${artifact.path} is ${String(artifact.byteLength)} bytes; ${adapter.mode} accepts at most ${String(adapter.fileConstraints.maxFileBytes)}`,
      );
    }
  }

  // -------------------------------- the import mode is one the target supports
  record('import.modeSupported');
  const declaredMode = String(target.importMode ?? '');
  if (declaredMode !== loaded.config.target.importMode) {
    fail(
      'import.modeSupported',
      `the manifest declares import mode "${declaredMode}" but the configuration says "${loaded.config.target.importMode}"`,
    );
  }
  for (const [object, count] of importRowsByObject) {
    if (count === 0) continue;
    for (const spec of adapter.objects.filter((item) => item.object === object)) {
      if (!(spec.supportedModes as readonly string[]).includes(declaredMode)) {
        fail(
          'import.modeSupported',
          `${adapter.mode} supports ${spec.supportedModes.join(', ')} for ${object}, but the package declares ${declaredMode}`,
        );
      }
    }
  }

  // ------------------------ an isolated row says why, and the package agrees
  record('isolated.corroborated');
  // A disposition is a claim about a row. Relabelling a delivered record as
  // ISOLATED, with every count adjusted to match, used to pass: an
  // ISOLATED_* reason code was accepted with no evidence anywhere behind it.
  // The authorized clears this package records, indexed by the row and field
  // they belong to. The corroboration below asks whether a particular row asked
  // to clear a particular field, and it used to answer by searching the whole
  // change log for every isolated row — work proportional to changes times
  // isolations, in a check that reads a handful of entries.

  // ---- what the relationship ledger says about a row, without holding it ----
  //
  // Three structures used to stand here and each was one entry per relationship:
  // the unresolved rows and their reasons, the reason each row is named under
  // whatever the disposition, and the relationship type of each row. Together
  // they were the association ledger indexed three ways, held from here to the
  // end of the verification, to answer a question about the handful of rows that
  // are isolated or left over for a relationship reason.
  //
  // They are answered by merging instead. Each question is projected into two
  // spilled families -- what the artifact asks, and what the ledger states --
  // walked in step, and only the *disagreements* survive the walk. A package
  // that verifies leaves all three of these empty, so what is held is bounded by
  // the failures rather than by the dataset.
  //
  // Each is skipped entirely when nothing asks. The ask is streamed straight
  // into the spill, so nothing is read twice and nothing is read at all where
  // none asks; spilling the whole ledger to answer nothing would move the cost
  // from memory to the scratch budget rather than remove it.
  //
  // ---- which of these are bounded by the failures, and which are not ----
  //
  // "Bounded by the failures" was claimed for ten structures and is true of
  // four. An adversarial pass established that; the accounting is written down
  // here rather than corrected in a summary, because the claim is made in this
  // file and this is where the next reader will look for it.
  //
  // Empty in a package that verifies, so genuinely bounded by disagreements:
  //   danglingPointers, uncorroboratedIsolations, uncorroboratedLeftovers,
  //   unsupportedContradictions.
  //
  // Bounded by a count that is smaller than the dataset but still grows with
  // it, which is not the same thing and is not what "bounded" should be taken
  // to mean:
  //   - `asked` in the unsupported-contradiction block below: one entry per
  //     leftover carrying ASSOCIATION_UNSUPPORTED_BY_TARGET, which is every
  //     source row with a relationship when the destination refuses the type
  //     the configuration declares;
  //   - `asked` and `flaggedAmongAsked` in the flag block below: one entry per
  //     field-level isolation, expanded through its merge family. The comment
  //     there called that "the bound this check is entitled to", which is a
  //     different bound, not a bounded one;
  //   - `blockedDeliveryRows` and `blockedAndIsolated` further down: one entry
  //     per flag that says it blocked a delivery, which in a migration whose
  //     destination refuses a lot of what it is given is most of the flags.
  //
  // All five are far smaller than the artifacts they replaced holding, and all
  // five are still row-scale. They are left as they are and named instead,
  // because the measurement says they are not what costs: with the conflict map
  // below fixed, `tools/verifier-memory-probe.mjs` measures what this whole
  // verification still holds at its peak as 1,664,152 bytes over 30,000 source
  // rows and 1,296,840 over 120,000 -- flat, not growing. Converting a set that
  // is empty on the corpus and then claiming a memory improvement is how the
  // ten came to be described as bounded in the first place.

  /**
   * Asks of an artifact, keyed exactly as the ledger states them.
   *
   * The spill is opened by the first ask rather than before it, and that is the
   * whole of what makes "nothing is read where nothing asks" true. This ran
   * `ask` twice -- once to count and once to spill -- so a package with no
   * associations at all, which is the case the guard was written for, paid for
   * an extra full reading of `isolated.csv` and `leftovers.csv` to be told
   * there was nothing to do. An adversarial pass measured that: five
   * unconditional readings of `isolated.csv` where the previous verifier had
   * two. Opening on demand gives the identical guard for one reading, and the
   * scratch family is declared only in the runs that have something to put in
   * it, so the counters a capacity measurement reads do not gain an empty
   * family either.
   *
   * The ask travels as the record as well as the key, because the caller looks
   * the answers up later by the raw text it read out of a cell.
   */
  const disagreements = (
    schema: string,
    ask: (add: (key: string) => void) => void,
    state: (add: (key: string) => void) => void,
  ): Set<string> => {
    const unmatched = new Set<string>();
    let opened: KeyedSpill<string> | null = null;
    const openOnce = (): KeyedSpill<string> => {
      if (opened === null) opened = openKeyedSpill<string>(scratch, `${schema}-asked`);
      return opened;
    };
    let anythingAsked = false;
    ask((key) => {
      anythingAsked = true;
      openOnce().add({ k: key, v: key });
    });
    if (!anythingAsked) return unmatched;
    const asks = openOnce();
    const stated = openKeyedSpill<null>(scratch, `${schema}-stated`);
    state((key) => stated.add({ k: key, v: null }));
    for (const group of coGroup(asks.seal(), stated.seal())) {
      if (group.left.length === 0 || group.right.length > 0) continue;
      unmatched.add(group.left[0] ?? group.key);
    }
    return unmatched;
  };

  // An isolation blamed on a relationship, which the ledger does not record as
  // unresolved for that row under that reason.
  const uncorroboratedIsolations = disagreements(
    'verify-isolated-association-reason',
    (add) => {
      scanTable(packageDir, 'isolated.csv', () => (row) => {
        const reason = row['reason_code'] ?? '';
        if (!reason.startsWith('ASSOCIATION_')) return;
        add(`${row['row_locator_id'] ?? ''}${PAIR_SEPARATOR}${reason}`);
      });
    },
    (add) => {
      scanTable(packageDir, 'associations.csv', () => (edge) => {
        if ((edge['disposition'] ?? '') !== 'UNRESOLVED') return;
        add(`${edge['row_locator_id'] ?? ''}${PAIR_SEPARATOR}${edge['reason_code'] ?? ''}`);
      });
    },
  );

  // A leftover blamed on a relationship, which the ledger does not name that row
  // under at all. `ASSOCIATION_UNSUPPORTED_BY_TARGET` is answered by the adapter
  // rather than by the ledger and is settled below, so it does not ask here.
  const uncorroboratedLeftovers = disagreements(
    'verify-leftover-association-reason',
    (add) => {
      scanTable(packageDir, 'leftovers.csv', () => (row) => {
        const reason = row['reason_code'] ?? '';
        if (!reason.startsWith('ASSOCIATION_') || reason === 'ASSOCIATION_UNSUPPORTED_BY_TARGET') return;
        add(`${row['row_locator_id'] ?? ''}${PAIR_SEPARATOR}${reason}`);
      });
    },
    (add) => {
      scanTable(packageDir, 'associations.csv', () => (edge) => {
        add(`${edge['row_locator_id'] ?? ''}${PAIR_SEPARATOR}${edge['reason_code'] ?? ''}`);
      });
    },
  );

  // A leftover claiming the destination does not carry its relationship, where
  // the adapter says it does. The relationship type is needed in the message, so
  // this one keeps a value -- for the rows that contradict the adapter, which is
  // none in a package that verifies. The type is the first the ledger records
  // for the row, which is what an index built by "set it if absent" held.
  //
  // `unsupportedContradictions` is bounded by the contradictions. The `asked`
  // set that feeds it is not: it holds one row locator per leftover carrying
  // this reason code, which is one per source row that declares a relationship
  // the destination refuses. Nothing is read where none asks, which is the
  // common case and the only reason this is affordable.
  const unsupportedContradictions = new Map<string, string>();
  {
    const asked = new Set<string>();
    scanTable(packageDir, 'leftovers.csv', () => (row) => {
      if ((row['reason_code'] ?? '') !== 'ASSOCIATION_UNSUPPORTED_BY_TARGET') return;
      asked.add(row['row_locator_id'] ?? '');
    });
    if (asked.size > 0) {
      const claims = openKeyedSpill<string>(scratch, 'verify-unsupported-leftover-rows');
      for (const rowId of asked) claims.add({ k: rowId, v: rowId });
      const types = openKeyedSpill<string>(scratch, 'verify-relationship-type-by-row');
      scanTable(packageDir, 'associations.csv', () => (edge) => {
        types.add({ k: edge['row_locator_id'] ?? '', v: edge['relationship_type'] ?? '' });
      });
      for (const group of coGroup(claims.seal(), types.seal())) {
        if (group.left.length === 0) continue;
        const relationshipType = group.right[0] ?? '';
        const support = adapter.relationships[relationshipType as keyof DestinationAdapter['relationships']];
        if (support !== undefined && support.kind === 'UNSUPPORTED') continue;
        // Keyed by the row locator as the artifacts spell it: the lookup below
        // is made with a cell that was never spilled and so was never escaped.
        unsupportedContradictions.set(group.left[0] ?? group.key, relationshipType);
      }
    }
  }

  const authorizedClears = new Set<string>();
  scanTable(packageDir, 'changes.csv', () => (row) => {
    if ((row['reason_code'] ?? '') !== 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION') return;
    authorizedClears.add(`${row['row_locator_id'] ?? ''}${PAIR_SEPARATOR}${row['destination_field'] ?? ''}`);
  });
  // A field is required either because the configuration says so or because the
  // destination does. Either way something has to say so: a mapping whose
  // object requires nothing cannot set a row aside for a missing requirement.
  // The exact fields each mapping can legitimately be missing, from the
  // configuration and from the destination's own requirements.
  const requiredFieldsByMapping = new Map<string, Set<string>>();
  for (const mapping of loaded.config.records) {
    const required = new Set<string>();
    for (const field of mapping.fields) {
      if (field.required) required.add(field.destinationField);
    }
    const spec = objectSpec(adapter, mapping.object);
    if (spec !== null) {
      for (const field of spec.requiredForCreate) required.add(field);
      for (const group of spec.requiredAnyOf) for (const field of group) required.add(field);
    }
    requiredFieldsByMapping.set(mapping.id, required);
  }
  const mergeConflictRows = new Set<string>();
  const mergeFamilies = new Map<string, string[]>();
  for (const merge of merges) {
    const family = [merge.survivorRowLocatorId, ...merge.absorbedRowLocatorIds];
    for (const member of family) {
      mergeConflictRows.add(member);
      mergeFamilies.set(member, family);
    }
  }

  // Which of the rows a field-level isolation rests on carry a flag.
  //
  // A set of every flagged row locator used to answer this, built from a whole
  // reading of `flags.csv`. That is one entry per flagged cell, and flags.csv is
  // one of the artifacts that grows with the dataset -- so a check that asks
  // about the handful of rows set aside for a field-level reason held an index
  // of every flag in the migration, and the parsed table behind it, for the rest
  // of the verification.
  //
  // The rows that ask are gathered first and `flags.csv` is asked about those:
  // the number of field-level isolations rather than the number of flags.
  // Nothing is read at all when none asks.
  //
  // That is smaller, and it is not bounded. Both sets below hold one entry per
  // field-level isolation, expanded through its merge family, and a migration
  // whose destination refuses a lot of what it is given sets aside most of the
  // dataset for exactly these reasons. Said plainly here because the earlier
  // wording -- "the bound this check is entitled to" -- reads as a claim that
  // this does not grow with the rows, and it does.
  const flaggedAmongAsked = new Set<string>();
  {
    const asked = new Set<string>();
    scanTable(packageDir, 'isolated.csv', () => (row) => {
      if (!FIELD_LEVEL_ISOLATION.has(row['reason_code'] ?? '')) return;
      const rowId = row['row_locator_id'] ?? '';
      // The isolation is recorded at the survivor's address, but the field
      // problem that caused it may sit on any row of the merge.
      for (const member of mergeFamilies.get(rowId) ?? [rowId]) asked.add(member);
    });
    if (asked.size > 0) {
      scanTable(packageDir, 'flags.csv', () => (row) => {
        const rowId = row['row_locator_id'] ?? '';
        if (asked.has(rowId)) flaggedAmongAsked.add(rowId);
      });
    }
  }

  // Already gathered, bounded by the number of conflicts.
  const conflictKeys = new Set(
    [...conflicted].filter(([, state]) => state.named).map(([key]) => key),
  );
  // Walked alongside the isolated list, which is in the same declared order.
  //
  // Pulled a row at a time rather than read into an array. `isolated.csv` is one
  // row per set-aside source row, and in a migration whose destination refuses a
  // lot of what it is given that is most of the dataset; this loop looks at each
  // row once and keeps nothing from it, so there was never a reason to have them
  // all at once. The order the rows arrive in is the order they are written in,
  // which is what the lineage cursor requires.
  const isolatedCorroborationLineage = cursor('isolated.corroborated/isolated.csv');
  for (const row of readCsvFileRows(artifactPath(packageDir, 'isolated.csv'), {
    ...CSV_LIMITS,
    filePath: 'isolated.csv',
  })) {
    const rowId = row['row_locator_id'] ?? '';
    const reason = row['reason_code'] ?? '';
    const rowKey = isolatedCorroborationLineage.at(row)?.migrationKey ?? '';
    if (FIELD_LEVEL_ISOLATION.has(reason)) {
      // The isolation is recorded at the survivor's address, but the field
      // problem that caused it may sit on any row of the merge.
      const family = mergeFamilies.get(rowId) ?? [rowId];
      if (!family.some((member) => flaggedAmongAsked.has(member))) {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for ${reason} but flags.csv records nothing about it`,
        );
      }
      continue;
    }
    if (reason === 'DESTINATION_REQUIRED_FIELD_MISSING') {
      // "This mapping requires something" was satisfied by every object of
      // every real destination, so it corroborated nothing and a delivered
      // record could be withheld by relabelling it. The package now names the
      // field, and the field has to be one this configuration or this
      // destination actually requires.
      //
      // Package-only verification cannot go further: proving the cell was
      // empty needs the source, and `kauro-core attest` is where that is proven.
      const mappingId = row['record_mapping_id'] ?? '';
      const named = row['field'] ?? '';
      if (named === '') {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for a missing required field without naming which one`,
        );
        continue;
      }
      if (!requiredFieldsByMapping.get(mappingId)?.has(named)) {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside because "${named}" is missing, but neither the configuration nor ${adapter.mode} requires it for record mapping "${mappingId}"`,
        );
      }
      continue;
    }
    if (reason === 'DESTINATION_KEY_CONFLICT') {
      if (!conflictKeys.has(rowKey)) {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for a destination key conflict that destination-conflicts.csv does not record`,
        );
      }
      continue;
    }
    if (
      reason === 'IDENTITY_MERGE_FIELD_CONFLICT' ||
      reason === 'IDENTITY_MERGE_CONSENT_CONFLICT' ||
      reason === 'ISOLATED_IDENTITY_CONFLICT'
    ) {
      if (!mergeConflictRows.has(rowId)) {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for an identity conflict but merges.json records no merge it belongs to`,
        );
      }
      continue;
    }
    if (reason === 'TARGET_CLEAR_NOT_REPRESENTABLE') {
      // Two things have to hold for this refusal to be honest: the destination
      // really has no way to say "empty this", and the plan really did ask to
      // empty the field the isolation names. Either one alone would let a
      // delivered record be withheld by relabelling it.
      const named = row['field'] ?? '';
      if (named === '') {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside because a clear cannot be represented, without naming which field`,
        );
        continue;
      }
      if (adapter.clearRepresentation.kind !== 'NOT_REPRESENTABLE') {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside because ${adapter.mode} cannot express a clear, but this adapter does express one`,
        );
        continue;
      }
      const family = mergeFamilies.get(rowId) ?? [rowId];
      const asked = family.some((member) => authorizedClears.has(`${member}${PAIR_SEPARATOR}${named}`));
      if (!asked) {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside because "${named}" could not be cleared, but changes.csv records no authorized clear of it`,
        );
      }
      continue;
    }
    if (reason === 'TARGET_CLEAR_TOKEN_COLLISION') {
      // Only a format that reserves a token can have a collision with it.
      if (adapter.clearRepresentation.kind !== 'EXPLICIT_TOKEN') {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for colliding with the clear token, but ${adapter.mode} reserves no such token`,
        );
      }
      continue;
    }
    if (reason === 'DESTINATION_VALUE_TOO_LONG') {
      // The destination has to have a length to exceed.
      const object = row['object'] ?? '';
      const spec = CANONICAL_OBJECTS.filter((candidate) => candidate === object).flatMap((candidate) =>
        adapter.objects.filter((item) => item.object === candidate),
      );
      if (!spec.some((item) => item.fields.some((field) => field.maxLength !== null))) {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for a value that is too long, but ${adapter.mode} declares no length limit for a ${object}`,
        );
      }
      continue;
    }
    if (
      reason === 'DESTINATION_INSTANCE_VALUE_TOO_LONG' ||
      reason === 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN' ||
      reason === 'DESTINATION_INSTANCE_REQUIRED_FIELD_MISSING'
    ) {
      // A fact about the instance rests on the attested target contract the
      // run consumed (audit MC-04). The package names that contract by digest
      // and the isolation names the field; a package-only verification can
      // corroborate that much and no more, because the contract itself is not
      // an artifact of the package. A run with no contract cannot have made
      // this finding, so such a row would be a delivered record withheld under
      // a code nothing checks.
      const named = row['field'] ?? '';
      const contractHash = (manifest['target'] as JsonObject | undefined)?.['targetContractHash'] ?? null;
      if (named === '') {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for ${reason} without naming which field the instance limits`,
        );
        continue;
      }
      if (typeof contractHash !== 'string' || contractHash === '') {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for ${reason}, an instance fact, but the package names no attested target contract`,
        );
      }
      continue;
    }
    if (reason.startsWith('ASSOCIATION_')) {
      // The relationship ledger is the witness: this row's relationship could
      // not be resolved, and says so under the same reason code.
      if (uncorroboratedIsolations.has(`${rowId}${PAIR_SEPARATOR}${reason}`)) {
        fail(
          'isolated.corroborated',
          `${rowId} was set aside for ${reason}, which associations.csv does not record for it`,
        );
      }
      continue;
    }
    // Anything else is a reason with no corroborator, which is how a
    // delivered record was withheld: relabel it with a code nothing checks.
    fail(
      'isolated.corroborated',
      `${rowId} was set aside for ${reason}, and nothing in the package corroborates it`,
    );
  }

  // ------------------------------- a flag says what was preserved, truthfully
  record('flags.agreeWithDelivery');
  // An absorbed row's lineage carries the survivor's migration key, so a flag
  // raised on the absorbed row would be compared against a value the survivor
  // legitimately supplied. changes.matchDeliveredValues has this exemption; this
  // check was missing it, and rejected correct packages.
  const absorbedRows = new Set(merges.flatMap((merge) => merge.absorbedRowLocatorIds));

  // The same shape as the change-log check: the flag list is co-sorted with the
  // lineage, so the record is read from a cursor, and the claims are spilled in
  // migration-key order so the delivered records can be walked past them.
  const flagClaims = openKeyedSpill<{
    rowLocatorId: string;
    destinationField: string;
    preservedValue: string;
    blockedDelivery: boolean;
  }>(scratch, 'verify-flag-claims');
  // The rows whose flag says it blocked delivery. One entry per such flag,
  // rather than one per flag -- smaller, and still growing with the dataset:
  // a run whose destination refuses a lot of what it is given blocks a lot of
  // deliveries. Named as row-scale here rather than called bounded, because
  // "bounded by how many flags say that" was read as the second.
  const blockedDeliveryRows = new Set<string>();
  {
    const flagKeys = cursor('flags.agreeWithDelivery/flags.csv');
    scanTable(packageDir, 'flags.csv', () => (row) => {
      const rowId = row['row_locator_id'] ?? '';
      if (absorbedRows.has(rowId)) return;
      const key = flagKeys.at(row)?.migrationKey ?? '';
      if (key === '') return;
      const blockedDelivery = (row['blocked_delivery'] ?? '') === 'true';
      if (blockedDelivery) blockedDeliveryRows.add(rowId);
      flagClaims.add({
        k: key,
        v: {
          rowLocatorId: rowId,
          destinationField: row['destination_field'] ?? '',
          preservedValue: row['preserved_value'] ?? '',
          blockedDelivery,
        },
      });
    });
  }

  // Which of those rows the isolated list actually holds, asked once.
  //
  // This was `isolatedTable.rows.some(...)` inside the loop below: a linear
  // search of the whole isolated list per flag, over a table that had been read
  // into memory to be searched. Two counts that both grow with the dataset,
  // multiplied together, to answer a membership question about the flags that
  // say they blocked a delivery. Nothing is read where none does. This set is
  // one entry per blocked row that is also isolated, so it is bounded by the
  // set above and grows with it.
  const blockedAndIsolated = new Set<string>();
  if (blockedDeliveryRows.size > 0) {
    scanTable(packageDir, 'isolated.csv', () => (row) => {
      const rowId = row['row_locator_id'] ?? '';
      if (blockedDeliveryRows.has(rowId)) blockedAndIsolated.add(rowId);
    });
  }

  for (const group of coGroup(
    flagClaims.seal(),
    deliveredRecords(),
  )) {
    const delivered = group.right[0];
    if (delivered === undefined) continue;
    for (const claim of group.left) {
      if (claim.blockedDelivery) {
        const stillThere = blockedAndIsolated.has(claim.rowLocatorId);
        if (!stillThere) {
          fail(
            'flags.agreeWithDelivery',
            `${claim.rowLocatorId} carries a flag that blocked delivery, but its record was delivered and it is not in isolated.csv`,
          );
        }
      }
      const header = headerForField(adapter, delivered.object, claim.destinationField);
      if (header === null || !(header in delivered.row)) continue;
      if (claim.preservedValue === '') continue;
      if ((delivered.row[header] ?? '') === claim.preservedValue) continue;
      fail(
        'flags.agreeWithDelivery',
        `flags.csv says ${claim.rowLocatorId}/${claim.destinationField} preserved "${claim.preservedValue}" but the import file holds "${delivered.row[header] ?? ''}"`,
      );
    }
  }

  // ------------------- one row of the source, described the same way everywhere
  //
  // The provenance check asks, of a row named by some other artifact, what the
  // lineage says about it. It used to answer from a map of every lineage row —
  // the whole largest artifact, held for the rest of the verification, to look
  // up a handful of columns.
  //
  // What it needs is those columns, so that is what is kept: one packed string
  // per row instead of a thirteen-column object. At a million rows that is the
  // difference between a few hundred megabytes and a few tens.
  //
  // Bounding it further means merging each artifact against the lineage instead
  // of looking rows up at all, which the declared row order makes possible and
  // which is owed rather than done.
  // Nothing at all now: the artifacts that repeat a source row provenance are
  // the ones declared in the same order as the lineage, so each is walked
  // alongside a lineage cursor and the comparison needs no index. A packed
  // string per source row used to stand here, which at a million rows was a
  // few tens of megabytes held for the rest of the verification.

  // ------------------- three passes over every artifact, made into one pass
  //
  // Unique keys, declared order and provenance each used to walk the whole
  // artifact list on their own, so an artifact all three touch was read three
  // times and then held by the cache for the rest of the verification. At a
  // million rows that is the largest thing the verifier does:
  // `unmapped-fields.csv` alone is 424 MB and nothing else looks at it.
  //
  // They are one pass now, and it reads without the cache: each artifact is
  // parsed once, checked three ways, and let go. Artifacts that a specific
  // check also needs are still cached by that check, so nothing is parsed twice
  // that was not already going to be.
  //
  // The checks themselves are unchanged, with one exception that is strictly
  // stronger: order is now compared row against previous row rather than by
  // building the whole key list and a sorted copy of it, which is the same
  // question asked without allocating twice the artifact to ask it.
  mark('before the three-in-one pass');
  record('artifacts.uniqueKeys');
  record('artifacts.provenanceAgrees');
  record('artifacts.ordering');

  const keyColumnsByPath = new Map(ARTIFACT_KEYS);
  const orderColumnsByPath = new Map(ARTIFACT_ORDER);
  const genericPaths = [
    ...new Set([...keyColumnsByPath.keys(), ...orderColumnsByPath.keys(), ...PROVENANCE_ARTIFACTS]),
  ].sort(compareCodeUnits);

  for (const path of genericPaths) {
    if (!listed.has(path)) continue;

    // Duplicate keys are found by comparing each row with the one before it,
    // not by remembering every key. Every artifact with a uniqueness key is
    // also written in an order that puts equal keys next to each other, and
    // that order is checked in this same pass, so the adjacent comparison sees
    // exactly what a set of every key would have seen.
    let previousKey: string | null = null;
    let previousOrderKey: string | null = null;
    let outOfOrder = false;
    let orderedBy = '';
    let provenanceCursor: LineageCursor | null = null;

    // What each of the three checks needs from this artifact, worked out once
    // from its headers rather than re-asked for every row.
    const plan = (headers: readonly string[]): ((row: Record<string, string>) => void) | null => {
      const keyColumns = keyColumnsByPath.get(path);
      let keyColumnsUsable = keyColumns !== undefined;
      if (keyColumns !== undefined) {
        const missing = keyColumns.filter((column) => !headers.includes(column));
        if (missing.length > 0) {
          fail('artifacts.uniqueKeys', `${path} has no ${missing.join(', ')} column to identify its rows by`);
          keyColumnsUsable = false;
        }
      }

      const declared = orderColumnsByPath.get(path);
      const orderColumns =
        declared !== undefined && !UNORDERED_ARTIFACTS.has(path) && declared.every(([column]) => headers.includes(column))
          ? declared
          : null;
      if (orderColumns !== null) orderedBy = orderColumns.map(([column]) => column).join(', ');

      const provenanceColumns =
        PROVENANCE_ARTIFACTS.includes(path) && headers.includes('row_locator_id')
          ? PROVENANCE_COLUMNS.filter((column) => headers.includes(column))
          : null;
      // Only where this artifact carries provenance, and every artifact that
      // does is written in the same order the lineage is.
      if (provenanceColumns !== null) {
        provenanceCursor = cursor(`artifacts.provenanceAgrees/${path}`);
      }

      if (!keyColumnsUsable && orderColumns === null && provenanceColumns === null) return null;

      return (row) => {
        if (keyColumns !== undefined && keyColumnsUsable) {
          const key = keyColumns.map((column) => row[column] ?? '').join(PAIR_SEPARATOR);
          if (previousKey === key) {
            fail(
              'artifacts.uniqueKeys',
              `${path} lists ${keyColumns.map((column) => `${column}=${row[column] ?? ''}`).join(', ')} more than once, so one row it should hold is missing`,
            );
          }
          previousKey = key;
        }

        if (orderColumns !== null && !outOfOrder) {
          const key = orderColumns.map(([column, kind]) => orderCell(row[column] ?? '', kind)).join(ORDER_SEPARATOR);
          if (previousOrderKey !== null && compareCodeUnits(previousOrderKey, key) > 0) outOfOrder = true;
          previousOrderKey = key;
        }

        if (provenanceColumns !== null && provenanceCursor !== null) {
          const rowId = row['row_locator_id'] ?? '';
          const facts = provenanceCursor.at(row);
          if (facts === null) {
            fail('artifacts.provenanceAgrees', `${path} names ${rowId}, which is in no lineage row`);
            return;
          }
          for (const column of provenanceColumns) {
            const said = facts.row[column] ?? '';
            if ((row[column] ?? '') === said) continue;
            fail(
              'artifacts.provenanceAgrees',
              `${path} says ${rowId} has ${column}="${row[column] ?? ''}" but the lineage says "${said}"`,
            );
          }
        }
      };
    };

    // Streamed unless something else already had to hold the artifact. None of
    // the three checks needs a row after it has looked at one — a set of keys
    // seen, one previous key, and a lookup against the lineage — so at a
    // million rows this reads a 424 MB artifact without ever holding it.
    scanTable(packageDir, path, plan);

    if (outOfOrder) {
      fail('artifacts.ordering', `${path} rows are not in ${orderedBy} order, so the package is not reproducible`);
    }
  }

  // ------------------------------ the figures the audit prints are recomputed
  record('reconciliation.figuresRecomputed');
  // Every number the audit prints as fact used to be readable straight out of
  // the reconciliation with nothing behind it.
  // Distinct rows counted without a set of every changed row: the change log is
  // written in row order, so every entry for one row is next to the rest, and
  // comparing each with the one before it is exact in constant memory.
  let rowsWithChanges = 0;
  let clearedRows = 0;
  let previousChangedRow: string | null = null;
  scanTable(packageDir, 'changes.csv', () => (row) => {
    const rowId = row['row_locator_id'] ?? '';
    if (rowId !== previousChangedRow) {
      rowsWithChanges += 1;
      previousChangedRow = rowId;
    }
    if ((row['reason_code'] ?? '') === 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION') clearedRows += 1;
  });
  if (rowsWithChanges !== reconciliation.cells.rowsWithChanges) {
    fail(
      'reconciliation.figuresRecomputed',
      `changes.csv covers ${String(rowsWithChanges)} source rows but the reconciliation claims ${String(reconciliation.cells.rowsWithChanges)}`,
    );
  }
  if (clearedRows !== reconciliation.cells.clearedByExplicitAuthorization) {
    fail(
      'reconciliation.figuresRecomputed',
      `${String(clearedRows)} cells were cleared by authorization but the reconciliation claims ${String(reconciliation.cells.clearedByExplicitAuthorization)}`,
    );
  }
  // Counted, not measured off a table that had been read into memory to be
  // measured: counting rows does not need rows.
  const flagRows = countTableRows(packageDir, 'flags.csv');
  if (flagRows !== reconciliation.cells.flagged) {
    fail(
      'reconciliation.figuresRecomputed',
      `flags.csv holds ${String(flagRows)} rows but the reconciliation claims ${String(reconciliation.cells.flagged)}`,
    );
  }
  // Distinct source rows, not artifact rows: one row can appear in two clusters.
  if (candidateRows !== reconciliation.identity.duplicateCandidateRows) {
    fail(
      'reconciliation.figuresRecomputed',
      `duplicate-candidates.csv names ${String(candidateRows)} source rows but the reconciliation claims ${String(reconciliation.identity.duplicateCandidateRows)}`,
    );
  }
  const edgeAccounted = Object.values(reconciliation.associations.byDisposition).reduce((sum, value) => sum + value, 0);
  if (edgeAccounted !== reconciliation.associations.accountedFor) {
    fail(
      'reconciliation.figuresRecomputed',
      `the relationship dispositions add up to ${String(edgeAccounted)} but the reconciliation claims ${String(reconciliation.associations.accountedFor)} accounted for`,
    );
  }
  if (reconciliation.associations.withoutDisposition !== 0) {
    fail('reconciliation.figuresRecomputed', 'the reconciliation reports relationships with no disposition');
  }
  const manifestSheetCount = manifestInputs.reduce((sum, file) => sum + (file.sheets ?? []).length, 0);
  if (manifestSheetCount !== reconciliation.inputs.sheetCount) {
    fail(
      'reconciliation.figuresRecomputed',
      `the manifest lists ${String(manifestSheetCount)} sheets but the reconciliation claims ${String(reconciliation.inputs.sheetCount)}`,
    );
  }

  // ------------------------------- a leftover row is one the mapping does not reach
  record('leftovers.corroborated');
  // Relabelling a delivered record as LEFTOVER, with the counts adjusted, used
  // to pass. A row is left over because nothing maps its sheet, and the
  // configuration in the package says which sheets those are.
  const mappedFileIds = new Set(loaded.config.records.map((mapping) => mapping.fileId));
  for (const mapping of loaded.config.associations) {
    if ('fileId' in mapping) mappedFileIds.add(mapping.fileId);
  }
  const fileIdByPath = new Map(loaded.config.files.map((file) => [file.path, file.id]));
  const associationOnlyFileIds = new Set<string>();
  for (const mapping of loaded.config.associations) {
    if ('fileId' in mapping) associationOnlyFileIds.add(mapping.fileId);
  }
  // The leftover list is written in the same order as the lineage, so the two
  // are walked together. One entry per source row used to stand here, to read
  // one column of the lineage for the few rows this check asks about.
  const leftoverLineage = cursor('leftovers.corroborated/leftovers.csv');
  scanTable(packageDir, 'leftovers.csv', () => (row) => {
    const rowId = row['row_locator_id'] ?? '';
    const reason = row['reason_code'] ?? '';
    const recordMapping = leftoverLineage.at(row)?.recordMappingId ?? '';
    if (reason === 'LEFTOVER_NO_RECORD_MAPPING') {
      if (recordMapping !== '') {
        fail(
          'leftovers.corroborated',
          `${rowId} is recorded as covered by no record mapping, but the lineage names one for it`,
        );
      }
      return;
    }
    if (reason === 'LEFTOVER_ASSOCIATION_SHEET_ONLY') {
      const fileId = fileIdByPath.get(row['file_path'] ?? '') ?? '';
      if (!associationOnlyFileIds.has(fileId)) {
        fail(
          'leftovers.corroborated',
          `${rowId} is recorded as belonging to a relationship-only sheet, which the configuration does not describe`,
        );
      }
      if (recordMapping !== '') {
        fail(
          'leftovers.corroborated',
          `${rowId} is recorded as relationship-only, but the lineage names a record mapping for it`,
        );
      }
      return;
    }
    if (reason === 'ASSOCIATION_UNSUPPORTED_BY_TARGET') {
      // The destination genuinely does not carry this relationship. The adapter
      // is the witness, and the adapter is not part of the package under test.
      // Settled above, against the type the ledger records for this row.
      const relationshipType = unsupportedContradictions.get(rowId);
      if (relationshipType !== undefined) {
        fail(
          'leftovers.corroborated',
          `${rowId} is left over because ${adapter.mode} does not support ${relationshipType}, which the adapter contradicts`,
        );
      }
      return;
    }
    if (reason.startsWith('ASSOCIATION_')) {
      if (uncorroboratedLeftovers.has(`${rowId}${PAIR_SEPARATOR}${reason}`)) {
        fail(
          'leftovers.corroborated',
          `${rowId} is left over for ${reason}, which associations.csv does not record for it`,
        );
      }
      return;
    }
    fail(
      'leftovers.corroborated',
      `${rowId} is left over for ${reason}, and nothing in the package corroborates it`,
    );
  });

  // ------------------------- a merge names rows the lineage agrees belong to it
  mark('before the merge members');
  record('merges.membersAgree');
  // Both directions of the same agreement, as one merge over two spilled
  // projections.
  //
  // "Only the rows that name a merge" was the bound it claimed, and in a
  // migration whose identity resolution merges heavily that is most of the
  // lineage: one entry per merged row, held in memory. Worse, the second loop
  // walked the whole of that map once per merge, so the cost was merges times
  // merged rows — two counts that both grow with the dataset, multiplied.
  //
  // Both sides are keyed by the row locator and walked in step instead. Each row
  // locator is visited once, with the merges that name it and what the lineage
  // records for it side by side, which is exactly what both questions ask.
  //
  // The lineage entry read is the first for a row rather than the last. Two
  // lineage rows at one locator is `lineage.singleDisposition`'s failure to
  // report; where it holds, first and last are the same row.
  //
  // A migration that merged nothing spills nothing. Both questions are about a
  // merge, and the loop per merge asked neither of them where there were no
  // merges, so this is the same behaviour at no cost rather than a shortcut.
  if (merges.length > 0) {
    const memberClaims = spillKeyed<string>(
      scratch,
      'verify-merge-member-rows',
      (function* () {
        for (const merge of merges) {
          for (const rowId of [merge.survivorRowLocatorId, ...merge.absorbedRowLocatorIds]) {
            yield { k: rowId, v: merge.mergeId };
          }
        }
      })(),
    );
    const lineageMergeIds = spillKeyed<string>(
      scratch,
      'verify-lineage-merge-ids',
      (function* () {
        for (const row of readCsvFileRows(artifactPath(packageDir, 'source-lineage.csv'), {
          ...CSV_LIMITS,
          filePath: 'source-lineage.csv',
        })) {
          const mergeId = row['merge_id'] ?? '';
          if (mergeId === '') continue;
          yield { k: row['row_locator_id'] ?? '', v: mergeId };
        }
      })(),
    );
    // A lineage row claiming a merge id that merges.json does not declare at all
    // is passed over here, exactly as the loop per merge passed over it: it is
    // `identifiers.recomputed` that holds a merge id to the keys it cites.
    const declaredMergeIds = new Set(merges.map((merge) => merge.mergeId));
    for (const group of coGroup(memberClaims, lineageMergeIds)) {
      const recorded = group.right[0] ?? '';
      for (const claimed of group.left) {
        if (recorded === claimed) continue;
        fail(
          'merges.membersAgree',
          `merge ${claimed} names ${group.key}, whose lineage row records merge "${recorded}"`,
        );
      }
      for (const recordedId of group.right) {
        if (!declaredMergeIds.has(recordedId)) continue;
        if (group.left.includes(recordedId)) continue;
        fail('merges.membersAgree', `${group.key} claims merge ${recordedId}, which does not name it`);
      }
    }
  }
  for (const merge of merges) {
    for (const conflict of merge.conflicts ?? []) {
      for (const value of conflict.values ?? []) {
        const rowId = value.rowLocatorId ?? '';
        if (rowId !== merge.survivorRowLocatorId && !merge.absorbedRowLocatorIds.includes(rowId)) {
          fail(
            'merges.membersAgree',
            `merge ${merge.mergeId} records a conflict between rows, one of which (${rowId}) is not part of the merge`,
          );
        }
      }
    }
  }

  // --------------- an owned relationship starts at the record its row produced
  record('associations.ownerSideAgrees');
  // A relationship declared by a column on a record's own row starts at that
  // record. Only endpoint existence was checked, so a delivered edge could be
  // re-pointed at any other delivered record of the right object.
  const ownerSideByMapping = new Map<string, 'FROM' | 'TO'>();
  const targetByMapping = new Map<
    string,
    { object: CanonicalObject; recordMappingId: string; bySourceRecordId: boolean }
  >();
  const edgeFileEnds = new Map<string, { from: string; to: string }>();
  for (const mapping of loaded.config.associations) {
    if (mapping.kind === 'EDGE_FILE') {
      // Both endpoint columns match the source record id of their target record
      // mapping, so both ends are as checkable as a column reference's near end.
      edgeFileEnds.set(mapping.id, { from: mapping.fromRecordMappingId, to: mapping.toRecordMappingId });
      continue;
    }
    ownerSideByMapping.set(mapping.id, mapping.ownerSide);
    const target = loaded.config.records.find((item) => item.id === mapping.targetRecordMappingId);
    if (target !== undefined) {
      targetByMapping.set(mapping.id, {
        object: target.object,
        recordMappingId: target.id,
        bySourceRecordId: mapping.targetMatchKey === 'SOURCE_RECORD_ID',
      });
    }
  }
  // The record each raw source id names, so the far end of a relationship can be
  // checked as well as the near end.
  // Keyed by the record mapping as well as the object: the same raw id in two
  // source systems is two records, which is the whole of G21, and a key without
  // the mapping made the second one overwrite the first.
  // One entry per source record id used to stand here, which is one entry per
  // source row. The questions asked of it -- which record a raw key names, and
  // whether that name is ambiguous -- are answered instead by spilling the
  // claims the ledger makes and merging them against the lineage.
  const recordIdClaims = openKeyedSpill<{ edgeId: string; end: string; rawKey: string; delivered: string }>(
    scratch,
    'verify-record-id-claims',
  );
  const objectByMapping = new Map(loaded.config.records.map((mapping) => [mapping.id, mapping.object]));
  const mapKeyFor = (recordMappingId: string, rawKey: string): string | null => {
    const object = objectByMapping.get(recordMappingId);
    if (object === undefined || rawKey === '') return null;
    return `${recordMappingId}${PAIR_SEPARATOR}${object}${PAIR_SEPARATOR}${rawKey}`;
  };

  const ownerClaims = openKeyedSpill<{ edgeId: string; side: 'FROM' | 'TO'; owned: string }>(
    scratch,
    'verify-owner-claims',
  );
  scanTable(packageDir, 'associations.csv', () => (row) => {
    const mappingId = row['association_mapping_id'] ?? '';
    const disposition = row['disposition'] ?? '';
    const edgeFile = edgeFileEnds.get(mappingId);
    if (edgeFile !== undefined) {
      if (disposition !== 'OUTPUT' && disposition !== 'DEDUPLICATED') return;
      for (const [end, recordMappingId] of [
        ['from', edgeFile.from],
        ['to', edgeFile.to],
      ] as const) {
        const rawKey = row[`${end}_key_raw`] ?? '';
        const mapKey = mapKeyFor(recordMappingId, rawKey);
        if (mapKey === null) continue;
        recordIdClaims.add({
          k: mapKey,
          v: { edgeId: row['source_edge_id'] ?? '', end, rawKey, delivered: row[`${end}_migration_key`] ?? '' },
        });
      }
      return;
    }
    const side = ownerSideByMapping.get(mappingId);
    if (side === undefined) return;
    if ((row['disposition'] ?? '') !== 'OUTPUT' && (row['disposition'] ?? '') !== 'DEDUPLICATED') return;
    const owned = side === 'FROM' ? row['from_migration_key'] ?? '' : row['to_migration_key'] ?? '';
    // The ledger is ordered by edge id and the lineage by file and row, so the
    // question "what record declared this edge" is answered by a spilled join
    // afterwards rather than from an index of every source row.
    ownerClaims.add({
      k: row['row_locator_id'] ?? '',
      v: { edgeId: row['source_edge_id'] ?? '', side, owned },
    });
    const target = targetByMapping.get(row['association_mapping_id'] ?? '');
    if (target === undefined || !target.bySourceRecordId) return;
    const rawKey = side === 'FROM' ? row['to_key_raw'] ?? '' : row['from_key_raw'] ?? '';
    const farEnd = side === 'FROM' ? row['to_migration_key'] ?? '' : row['from_migration_key'] ?? '';
    if (rawKey === '') return;
    const mapKey = `${target.recordMappingId}${PAIR_SEPARATOR}${target.object}${PAIR_SEPARATOR}${rawKey}`;
    recordIdClaims.add({
      k: mapKey,
      v: { edgeId: row['source_edge_id'] ?? '', end: side === 'FROM' ? 'to' : 'from', rawKey, delivered: farEnd },
    });
  });

  // What each source record id actually names, merged against the claims the
  // ledger makes about it. A raw key that names two different records names
  // nothing -- the ambiguity is the answer -- so a group with two distinct
  // records is passed over exactly as the old index passed over an ambiguous
  // entry.
  const recordsBySourceRecordId = spillKeyed(
    scratch,
    'verify-source-record-ids',
    (function* () {
      for (const row of readCsvFileRows(artifactPath(packageDir, 'source-lineage.csv'), {
        ...CSV_LIMITS,
        filePath: 'source-lineage.csv',
      })) {
        const sourceRecordId = row['source_record_id'] ?? '';
        const key = row['migration_key'] ?? '';
        if (sourceRecordId === '' || key === '') continue;
        yield {
          k: `${row['record_mapping_id'] ?? ''}${PAIR_SEPARATOR}${row['object'] ?? ''}${PAIR_SEPARATOR}${sourceRecordId}`,
          v: key,
        };
      }
    })(),
  );
  // The records a source id names are summarized to one row per id before the
  // join: the first record and whether any other record shared the id. A source
  // id that many rows share (a merge of n rows, a hot parent) therefore costs
  // one right row, and the claims against it -- one per edge -- are walked in
  // pieces of at most the bound, so no key's bucket is ever held whole (B02-R3).
  const joinBound = options.joinBound ?? VERIFY_JOIN_BOUND;
  const namedRecords = (function* (): IterableIterator<{ k: string; v: { first: string; ambiguous: boolean } }> {
    let held: { k: string; v: { first: string; ambiguous: boolean } } | null = null;
    for (const entry of recordsBySourceRecordId) {
      if (held !== null && held.k === entry.k) {
        if (entry.v !== held.v.first) held.v.ambiguous = true;
        continue;
      }
      if (held !== null) yield held;
      held = { k: entry.k, v: { first: entry.v, ambiguous: false } };
    }
    if (held !== null) yield held;
  })();
  for (const group of coGroup(recordIdClaims.seal(), namedRecords, { bound: joinBound, scratch })) {
    options.observeJoin?.('associations.ownerSideAgrees', Math.max(group.left.length, group.right.length));
    if (group.left.length === 0) continue;
    const found = group.right[0];
    if (found === undefined) continue;
    if (found.ambiguous) continue;
    const named = found.first;
    for (const claim of group.left) {
      if (claim.delivered === named) continue;
      fail(
        'associations.ownerSideAgrees',
        `edge ${claim.edgeId} names "${claim.rawKey}", whose record is ${named}, but points at ${claim.delivered}`,
      );
    }
  }

  for (const group of coGroup(ownerClaims.seal(), lineageByLocator())) {
    const expected = group.right[0]?.migrationKey ?? '';
    if (expected === '') continue;
    for (const claim of group.left) {
      if (claim.owned === expected) continue;
      fail(
        'associations.ownerSideAgrees',
        `edge ${claim.edgeId} is declared by ${group.key}, whose record is ${expected}, but its ${claim.side.toLowerCase()} end is ${claim.owned}`,
      );
    }
  }

  // ------------------ the verification notes are the ones the adapter declares
  record('instanceVerification.matchesAdapter');
  const declaredNotes = adapter.instanceVerification.map(
    (item) =>
      `${item.scope}${PAIR_SEPARATOR}${item.detail}${PAIR_SEPARATOR}${item.sourceUrl}${PAIR_SEPARATOR}DESTINATION_INSTANCE_VERIFICATION_REQUIRED`,
  );
  const packagedNotes = readTable(packageDir, 'instance-verification.csv').rows.map(
    (row) =>
      `${row['scope'] ?? ''}${PAIR_SEPARATOR}${row['detail'] ?? ''}${PAIR_SEPARATOR}${row['source_url'] ?? ''}${PAIR_SEPARATOR}${row['reason_code'] ?? ''}`,
  );
  if (declaredNotes.join(ORDER_SEPARATOR) !== packagedNotes.join(ORDER_SEPARATOR)) {
    fail(
      'instanceVerification.matchesAdapter',
      `instance-verification.csv does not match what the ${adapter.mode} adapter declares`,
    );
  }

  // ------------------------------- every derived identifier is recomputed
  mark('before the identifiers');
  record('identifiers.recomputed');
  // A review forged a merge, invented a record and rewrote a migration key,
  // and all three verified clean: the verifier recomputed no identifier at
  // all. Every one of these is a pure function of columns the package already
  // carries, so an identifier that does not follow from its own inputs is a
  // package that contradicts itself.
  scanTable(packageDir, 'source-lineage.csv', () => (row) => {
    const fileId = row['file_id'] ?? '';
    const sheetId = row['sheet_id'] ?? '';
    const rowNumber = row['row_number'] ?? '';
    const expectedFileId = makeFileId(row['file_sha256'] ?? '');
    // A file whose bytes another occurrence shares takes its id from its hash and
    // its path; any other file's id follows from its hash alone.
    const occurrenceFileId = makeOccurrenceFileId(row['file_sha256'] ?? '', row['file_path'] ?? '');
    if (fileId !== expectedFileId && fileId !== occurrenceFileId) {
      fail(
        'identifiers.recomputed',
        `file id ${fileId} does not follow from the file's hash, which gives ${expectedFileId}, or from its hash and path, which give ${occurrenceFileId}`,
      );
    }
    if (!/^[0-9]+$/u.test(rowNumber)) {
      fail('identifiers.recomputed', `${row['row_locator_id'] ?? ''} has row number "${rowNumber}"`);
      return;
    }
    const expectedLocator = makeRowLocatorId(fileId, sheetId, Number.parseInt(rowNumber, 10));
    if ((row['row_locator_id'] ?? '') !== expectedLocator) {
      fail(
        'identifiers.recomputed',
        `row locator ${row['row_locator_id'] ?? ''} does not follow from its file, sheet and row number, which give ${expectedLocator}`,
      );
    }

    const migrationKey = row['migration_key'] ?? '';
    if (migrationKey === '') return;
    const objectName = row['object'] ?? '';
    const object = CANONICAL_OBJECTS.find((candidate) => candidate === objectName);
    if (object === undefined) {
      fail('identifiers.recomputed', `${expectedLocator} carries a migration key under object "${objectName}"`);
      return;
    }
    const recordIdentityKey = row['record_identity_key'] ?? '';
    const expectedKey =
      recordIdentityKey === ''
        ? migrationKeyFromRow(
            object,
            row['source_system'] ?? '',
            row['source_namespace'] ?? '',
            row['bundle_id'] ?? '',
            expectedLocator,
          )
        : migrationKeyFromIdentity(object, recordIdentityKey);
    if (migrationKey !== expectedKey) {
      fail(
        'identifiers.recomputed',
        `${expectedLocator} claims migration key ${migrationKey}, but its own identity gives ${expectedKey}`,
      );
    }
  });

  // A record is one identity, however many rows fed it, and the key it is
  // named by has to be the smallest identity key any of those rows holds.
  // Spilled and grouped rather than indexed: a record named by two different
  // identity keys is a key whose group holds two values, and the group is the
  // only thing held.
  const identityByKey = openKeyedSpill<string>(scratch, 'verify-record-identity');
  scanTable(packageDir, 'source-lineage.csv', () => (row) => {
    const migrationKey = row['migration_key'] ?? '';
    if (migrationKey === '') return;
    identityByKey.add({ k: migrationKey, v: row['record_identity_key'] ?? '' });
  });
  for (const group of coGroup(identityByKey.seal(), [])) {
    const first = group.left[0];
    if (first === undefined) continue;
    if (group.left.every((value) => value === first)) continue;
    fail(
      'identifiers.recomputed',
      `${group.key} is named by two different identity keys, so its rows do not describe one record`,
    );
  }
  scanTable(packageDir, 'source-lineage.csv', () => (row) => {
    const recordIdentityKey = row['record_identity_key'] ?? '';
    const own = row['identity_key'] ?? '';
    if (recordIdentityKey === '' || own === '') return;
    if (compareCodeUnits(recordIdentityKey, own) > 0) {
      fail(
        'identifiers.recomputed',
        `${row['row_locator_id'] ?? ''} holds identity key ${own}, which sorts before the key ${recordIdentityKey} its record is named by`,
      );
    }
  });

  // Streamed, and this one matters more than it looks. `unmapped-fields.csv` is
  // 338 MB at 900,000 rows and this is the only check that wants its rows — so
  // reading it into memory here held the second-largest artifact in the package
  // for the rest of the verification to recompute one identifier per row.
  for (const path of ['changes.csv', 'flags.csv', 'unmapped-fields.csv']) {
    if (!listed.has(path)) continue;
    const inspect = (row: Readonly<Record<string, string>>): void => {
      const columnIndex = row['column_index'] ?? '';
      if (!/^[0-9]+$/u.test(columnIndex)) return;
      const expected = makeColumnLocatorId(
        row['file_id'] ?? '',
        row['sheet_id'] ?? '',
        Number.parseInt(columnIndex, 10),
      );
      if ((row['column_locator_id'] ?? '') !== expected) {
        fail(
          'identifiers.recomputed',
          `${path} names column ${row['column_locator_id'] ?? ''}, which does not follow from its file, sheet and index (${expected})`,
        );
      }
    };
    const carries = (headers: readonly string[]): boolean =>
      headers.includes('column_locator_id') && headers.includes('column_index');

    // Streamed, like everything else: no artifact outlives the check that
    // wanted it.
    scanTable(packageDir, path, (headers) => (carries(headers) ? inspect : null));
  }

  for (const merge of merges) {
    const expected = mergeIdFor(merge.identityEvidence.map((item) => item.value ?? ''));
    if (merge.mergeId !== expected) {
      fail(
        'identifiers.recomputed',
        `merge ${merge.mergeId} does not follow from the keys it cites, which give ${expected}`,
      );
    }
  }

  scanTable(packageDir, 'associations.csv', () => (row) => {
    const expected = edgeIdFor(
      row['association_mapping_id'] ?? '',
      row['row_locator_id'] ?? '',
      row['from_key_raw'] ?? '',
      row['to_key_raw'] ?? '',
    );
    if ((row['source_edge_id'] ?? '') !== expected) {
      fail(
        'identifiers.recomputed',
        `relationship ${row['source_edge_id'] ?? ''} does not follow from the row and keys it names, which give ${expected}`,
      );
    }
  });

  // Recomputed during the single read of duplicate-candidates.csv above, one
  // cluster at a time, and reported here where the rest of `identifiers.recomputed`
  // is reported. What crosses the distance between the two is a list of
  // disagreements rather than a copy of the table.
  for (const problem of clusterProblems) fail('identifiers.recomputed', problem);

  record('audit.derivedFromReconciliation');
  const auditOnDisk = readText(packageDir, 'audit.md');
  const instanceVerification = readTable(packageDir, 'instance-verification.csv').rows.map((row) => ({
    scope: row['scope'] ?? '',
    detail: row['detail'] ?? '',
    sourceUrl: row['source_url'] ?? '',
    reasonCode: 'DESTINATION_INSTANCE_VERIFICATION_REQUIRED' as const,
  }));
  const expectedAudit = renderAudit(reconciliation, {
    instanceVerification,
    vendorSources: adapter.sources,
    adapterNotes: adapter.objects.flatMap((spec) => spec.notes),
  });
  if (auditOnDisk !== expectedAudit) {
    fail(
      'audit.derivedFromReconciliation',
      'audit.md does not match what the reconciliation implies, so at least one figure in it was produced independently',
    );
  }

  // ---------------------------------- what the destination was asked to match
  //
  // The package states this rather than leaving a reader to infer it from a
  // column, so the verifier has to hold it to the configuration it was produced
  // from. A package that claims a matching rule its own plan did not declare is
  // making a claim about somebody's instance that nothing authorised.
  record('destinationMatching.declared');
  const matchingTable = readTable(packageDir, 'destination-matching.csv');
  const declaredMatching = new Map(
    loaded.config.destinationMatching.map((entry) => [entry.recordMappingId, entry]),
  );
  for (const row of matchingTable.rows) {
    const mappingId = row['record_mapping_id'] ?? '';
    const declared = declaredMatching.get(mappingId);
    if (declared === undefined) {
      fail(
        'destinationMatching.declared',
        `destination-matching.csv names record mapping ${mappingId}, which the configuration does not declare a match for`,
      );
      continue;
    }
    if ((row['match_authority'] ?? '') !== declared.matchAuthority) {
      fail(
        'destinationMatching.declared',
        `${mappingId} is delivered matching on ${row['match_authority'] ?? ''} but the configuration declared ${declared.matchAuthority}`,
      );
    }
    // RECORD_ID resolves to the destination's own identifier rather than to a
    // declared field, so an empty declaration is the expected reading there.
    const declaredField = declared.targetField ?? '';
    const writtenField = row['target_field'] ?? '';
    if (declaredField !== '' && writtenField !== declaredField) {
      fail(
        'destinationMatching.declared',
        `${mappingId} is delivered matching on field "${writtenField}" but the configuration declared "${declaredField}"`,
      );
    }
  }
  if (matchingTable.rows.length !== declaredMatching.size) {
    fail(
      'destinationMatching.declared',
      `the configuration declares ${String(declaredMatching.size)} destination match rules but the package states ${String(matchingTable.rows.length)}`,
    );
  }

  // A column Kauro made up is never what the destination is asked to match on,
  // and this is the last place that can say so before a package is used. The
  // spellings V1 packages used are on the list too: 01_IMPORT no longer carries
  // a trace key, but a property an agency created to hold one is still there.
  record('destinationMatching.notTheTraceKey');
  const traceKeyNames = new Set(
    [
      adapter.associationKeyHeader,
      adapter.associationFromHeader,
      adapter.associationToHeader,
      'kauro_trace_key',
      'Kauro Trace Key',
      'Kauro_Trace_Key__c',
    ].map((name) => name.toLowerCase()),
  );
  for (const row of matchingTable.rows) {
    const field = (row['target_field'] ?? '').toLowerCase();
    if (field !== '' && traceKeyNames.has(field)) {
      fail(
        'destinationMatching.notTheTraceKey',
        `${row['record_mapping_id'] ?? ''} is delivered matching on "${row['target_field'] ?? ''}", which is a column Kauro made up rather than a field the instance carries`,
      );
    }
  }

  // Matching an existing record needs evidence about the instance it is matched
  // against, and the contract digest is the package's record of having had it.
  record('destinationMatching.contractRecorded');
  const declaredImportMode = String((manifest['target'] as JsonObject | undefined)?.['importMode'] ?? '');
  const recordedContract = (manifest['target'] as JsonObject | undefined)?.['targetContractHash'] ?? null;
  if (declaredImportMode !== 'CREATE_ONLY' && (recordedContract === null || recordedContract === '')) {
    fail(
      'destinationMatching.contractRecorded',
      `the package matches existing records in ${declaredImportMode} but names no captured target contract`,
    );
  }
  if (declaredImportMode === 'CREATE_ONLY' && matchingTable.rows.some((row) => (row['match_authority'] ?? '') !== 'NONE')) {
    fail(
      'destinationMatching.contractRecorded',
      'a create-only package states a match authority, but a create-only import matches nothing',
    );
  }

  for (const opened of openCursors) opened.close();

  return {
    packageDir,
    passed: problems.length === 0,
    checks,
    problems,
    artifactCount: artifacts.length,
    sourceRows: reconciliation.sourceRows.total,
  };
}

function uniqueObjects(
  config: ReturnType<typeof loadConfig>['config'],
): { object: CanonicalObject }[] {
  const seen = new Map<string, { object: CanonicalObject }>();
  for (const mapping of config.records) {
    seen.set(mapping.object, { object: mapping.object });
  }
  return [...seen.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, value]) => value);
}

// ------------------------------------------------------------------- reading

/**
 * Where an artifact is, given what it is called.
 *
 * Checks name artifacts the way the contract does -- `leftovers.csv`, not
 * `02_EXCEPTIONS/leftovers.csv` -- so that moving an artifact between areas is
 * a change to the layout and not a hundred changes here. It also means the
 * reader and the writer resolve a name through exactly the same function, so a
 * package cannot be written to one address and verified at another.
 */
function artifactPath(packageDir: string, name: string): string {
  return join(packageDir, ...packagePath(name).split('/'));
}

/**
 * Bytes per read.
 *
 * Fixed, so what a verification holds while reading a file does not depend on
 * how large the file is.
 *
 * Exported because the tamper suite asserts about read boundaries -- a case
 * that means to split a character across one has to know where one falls. It
 * kept its own `const READ_BLOCK_BYTES = 1 << 16` to do that, and an
 * adversarial pass was right about what that costs: change the size here and
 * the test goes on walking offsets that are no longer boundaries, so the case
 * it calls "the only discriminating one" stops discriminating and goes on
 * passing. Two constants cannot check each other. There is one now, and the
 * suite imports it.
 *
 * `src/ingest/read-csv-file.ts` still declares its own block size for its own
 * reads, and this is deliberately not coupled to it: exporting an ingest
 * internal to be read here would make a change to how ingest reads a file a
 * change to how the verifier hashes one. What the two share is the property,
 * not the number -- each reads in fixed blocks so neither's memory depends on
 * the file. The suite's boundary cases therefore hold every block size in the
 * plausible range rather than only this one, which is what makes them
 * independent of which of the two they are exercising.
 */
export const READ_BLOCK_BYTES = 1 << 16;

/** What a file weighs and what it hashes to, established without holding it. */
interface FileDigest {
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * A file's SHA-256 and its length, read a block at a time.
 *
 * `sha256Hex` takes its input whole by construction, which is right where the
 * input is a short string and wrong where it is an artifact: the manifest check
 * reads every file in the package, and taking each one whole meant the first
 * check a verification runs allocated the entire package.
 *
 * This is not a second definition of the hash. It is `node:crypto` SHA-256 fed
 * in pieces, which is the same digest by construction of the algorithm, and the
 * repository holds it to that rather than asserting it: every manifest in the
 * fixtures is written with `sha256Hex` over the whole file, and the tamper
 * suite's untampered control rewrites and re-verifies one, so a divergence
 * between the two forms would fail on every artifact of every fixture.
 *
 * Throws if the file cannot be opened, which is how a caller learns an artifact
 * the manifest lists is not in the package.
 */
function digestFile(path: string): FileDigest {
  const hash = createHash('sha256');
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
  let byteLength = 0;
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      // The digest copies what it is given into its own state, so the block
      // buffer is reused rather than reallocated per read.
      hash.update(buffer.subarray(0, read));
      byteLength += read;
    }
  } finally {
    closeSync(handle);
  }
  return { sha256: hash.digest('hex'), byteLength };
}

/**
 * A whole artifact as text.
 *
 * Still here, and deliberately narrow: the manifest, the reconciliation and the
 * audit are structural documents that are small whatever the migration held, and
 * reading one whole costs nothing that grows. Every artifact that grows with the
 * row count is read in blocks instead.
 */
function readText(packageDir: string, relativePath: string): string {
  const bytes = readFileSync(artifactPath(packageDir, relativePath));
  return decodeSource(bytes, null, relativePath).text;
}

function readJson(packageDir: string, relativePath: string): JsonValue extends never ? never : JsonObject {
  return parseJson(readText(packageDir, relativePath)) as JsonObject;
}

/**
 * Artifacts already parsed during this verification.
 *
 * The checks read the same artifact repeatedly — at half a million rows,
 * `associations.csv` was read five times, `formula-risk.csv` four, and every
 * import file three. Each of those decoded the file again into a string twice
 * its size on disk and built every row object again, so most of what
 * verification allocated was a second and third copy of something it had
 * already read, and most of what it spent was collecting them.
 *
 * The cache is per verification and lives no longer than the call, so it cannot
 * carry a stale reading of an artifact from one verification into another. What
 * it holds is bounded by the package: a table that was going to be read anyway.
 */
type TableCache = Map<string, Table>;

function readTable(packageDir: string, relativePath: string, cache?: TableCache): Table {
  if (cache !== undefined) {
    const seen = cache.get(relativePath);
    if (seen !== undefined) return seen;
    const parsed = readTableUncached(packageDir, relativePath);
    cache.set(relativePath, parsed);
    return parsed;
  }
  return readTableUncached(packageDir, relativePath);
}

/**
 * Read an artifact row by row, keeping no row.
 *
 * The same reader as `readTable`, differing only in what becomes of a row once
 * the caller has looked at it. Use it for a check that needs a row and then
 * never again: at a million rows the artifacts are hundreds of megabytes each
 * and the array of rows is the largest thing a verification builds.
 *
 * The cells are not copied here, and that is the difference that makes this
 * worth having. `readTable` copies every cell because its rows outlive parsing,
 * and a cell held as a slice of the decoded text keeps the whole text alive. A
 * row handed to `onRow` dies as soon as the call returns, so its slices die with
 * it and there is nothing to release.
 */
/**
 * How many rows an artifact holds.
 *
 * Counting rows does not need rows. Three checks ask only this — the manifest's
 * row count, the reconciliation's counts, and the association ledger — and
 * between them they cover every artifact in the package, so reading each one
 * into memory to measure its length was the verification's widest sweep and its
 * least necessary one.
 */
/**
 * Whether an import file holds a cell a spreadsheet would read as a formula.
 * Streamed; a file that cannot be read has already been reported by the digest
 * check and has nothing to compare.
 */
function importFileHasRiskyCell(packageDir: string, path: string): boolean {
  let risky = false;
  let header = true;
  try {
    scanCsvFile(artifactPath(packageDir, path), { ...CSV_LIMITS, filePath: path }, (_recordNumber, fields) => {
      if (header) {
        header = false;
        return;
      }
      for (const value of fields) {
        if (startsLikeFormula(value)) {
          risky = true;
          throw STOP_SCAN;
        }
      }
    });
  } catch (error) {
    if (error !== STOP_SCAN) return false;
  }
  return risky;
}

/**
 * A human view is its import file with one apostrophe in front of each cell the
 * formula predicate flags, and nothing else. Re-derived here from the import
 * file's own bytes, a record at a time, and compared cell by cell.
 */
function compareViewWithImport(
  packageDir: string,
  importPath: string,
  viewPath: string,
  fail: (check: string, detail: string) => void,
): void {
  const expectedCell = (value: string): string => (startsLikeFormula(value) ? `'${value}` : value);
  let source: IterableIterator<readonly string[]>;
  let view: IterableIterator<readonly string[]>;
  try {
    source = readCsvFileRecords(artifactPath(packageDir, importPath), { ...CSV_LIMITS, filePath: importPath });
    view = readCsvFileRecords(artifactPath(packageDir, viewPath), { ...CSV_LIMITS, filePath: viewPath });
  } catch {
    return;
  }
  let record = 0;
  let reported = 0;
  for (;;) {
    const left = source.next();
    const right = view.next();
    if (left.done === true && right.done === true) return;
    record += 1;
    if (left.done === true || right.done === true) {
      fail(
        'humanView.matchesImport',
        `${viewPath} and ${importPath} do not hold the same number of records (they differ at record ${String(record)})`,
      );
      return;
    }
    const want = left.value.map(expectedCell);
    const got = right.value;
    if (want.length !== got.length || want.some((value, index) => value !== got[index])) {
      reported += 1;
      if (reported <= 3) {
        fail('humanView.matchesImport', `${viewPath} record ${String(record)} is not ${importPath} record ${String(record)} with its risky cells neutralised`);
      }
    }
  }
}

/** No cell of a human view may begin the way a spreadsheet reads a formula. */
function assertNoExecutableCell(packageDir: string, path: string, fail: (check: string, detail: string) => void): void {
  let reported = 0;
  let total = 0;
  try {
    scanCsvFile(artifactPath(packageDir, path), { ...CSV_LIMITS, filePath: path }, (recordNumber, fields) => {
      for (let column = 0; column < fields.length; column += 1) {
        if (!startsLikeFormula(fields[column] ?? '')) continue;
        total += 1;
        reported += 1;
        if (reported <= 3) {
          fail('humanView.noExecutableCell', `${path} record ${String(recordNumber)} column ${String(column + 1)} begins like a spreadsheet formula and this file is a human view`);
        }
      }
    });
  } catch {
    return;
  }
  if (total > 3) fail('humanView.noExecutableCell', `${path} holds ${String(total)} executable cells in total; the first 3 are named above`);
}

function countTableRows(packageDir: string, relativePath: string, cache?: TableCache): number {
  const cached = cache?.get(relativePath);
  if (cached !== undefined) return cached.rows.length;
  const recordCount = countCsvRecords(artifactPath(packageDir, relativePath), {
    ...CSV_LIMITS,
    filePath: relativePath,
  });
  // The header is a record like any other to the reader, and it is not a row.
  return Math.max(0, recordCount - 1);
}

function scanTable(
  packageDir: string,
  relativePath: string,
  // Given the headers, says what to do with each row — or null, to read no
  // rows at all. Deciding once, here, is what keeps the per-row work to the
  // columns a check actually reads.
  plan: (headers: readonly string[]) => ((row: Record<string, string>) => void) | null,
): void {
  let headers: readonly string[] | null = null;
  let onRow: ((row: Record<string, string>) => void) | null = null;
  try {
    scanCsvFile(artifactPath(packageDir, relativePath), { ...CSV_LIMITS, filePath: relativePath }, (_recordNumber, fields) => {
      if (headers === null) {
        headers = [...fields];
        onRow = plan(headers);
        // Nothing to ask of the rows. Stopping here is worth the throw: this is
        // how the pass skips an artifact it has no check for without decoding
        // the whole of it a second time to find that out.
        if (onRow === null) throw STOP_SCAN;
        return;
      }
      const row: Record<string, string> = {};
      const names = headers;
      for (let index = 0; index < names.length; index += 1) {
        row[names[index] ?? ''] = fields[index] ?? '';
      }
      (onRow as (row: Record<string, string>) => void)(row);
    });
  } catch (error) {
    if (error !== STOP_SCAN) throw error;
  }
  // An artifact with a header and no rows still gets its plan made, so a check
  // that only looks at the header runs on an empty artifact too.
  if (headers === null) plan([]);
}

/** Thrown to end a scan early. A sink cannot return a verdict, and giving it one would be a second way for the reader to stop. */
const STOP_SCAN = Symbol('stop scanning');

/**
 * How many distinct values a column may hold before it stops being pooled.
 *
 * A column that has said something new four thousand times running is one where
 * every row differs — a hash, a key, a row number — and pooling it would build a
 * table of nine hundred thousand entries to notice that nothing ever repeats.
 * Above the limit the column is simply copied, as it always was.
 */
const VALUE_POOL_LIMIT = 4_096;

function readTableUncached(packageDir: string, relativePath: string): Table {
  const text = readText(packageDir, relativePath);
  const parsed = readCsv(text, { ...CSV_LIMITS, filePath: relativePath });
  const header = parsed.records[0];
  if (header === undefined) {
    return { headers: [], rows: [] };
  }
  const headers = [...header.fields];

  // One pool per column, for the length of this read only.
  //
  // The artifacts are mostly repetition down a column. A million-row lineage
  // names the same handful of files, sheets, dispositions, reason codes,
  // objects, source systems and record mappings on every row, and each of those
  // used to be a separate string: thirteen columns of a million rows is thirteen
  // million strings to say what a dozen would.
  //
  // Pooling keeps one string per distinct value and points every row at it.
  // Nothing about the rows changes — the strings compare by value, so a pooled
  // cell and a copied cell are the same cell to every check that reads it.
  const pools = headers.map(() => new Map<string, string>());

  const rows = parsed.records.slice(1).map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((name, index) => {
      const cell = record.fields[index] ?? '';
      if (cell.length === 0) {
        row[name] = '';
        return;
      }
      const pool = pools[index];
      const pooled = pool?.get(cell);
      if (pooled !== undefined) {
        row[name] = pooled;
        return;
      }
      // Copied, not referenced.
      //
      // A field is taken as a slice of the artifact's decoded text, and a slice
      // keeps the whole text it was cut from alive. These rows outlive parsing,
      // so without this every artifact would hold its own decoded text — twice
      // the file size on disk — for the length of the verification.
      //
      // Every cell is copied, not just the long ones. One surviving slice is
      // enough to keep the parent, so copying most of them releases nothing:
      // measured, copying all of them saved 316 MiB at half a million rows and
      // copying only the long ones was 791 MiB worse than that.
      const copied = Buffer.from(cell, 'utf8').toString('utf8');
      // Keyed by the copy, never by the slice. Keying by the slice would put the
      // artifact's whole decoded text back into the pool it was meant to free.
      if (pool !== undefined && pool.size < VALUE_POOL_LIMIT) pool.set(copied, copied);
      row[name] = copied;
    });
    return row;
  });
  return { headers, rows };
}

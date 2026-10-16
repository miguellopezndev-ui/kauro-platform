import type { DestinationAdapter } from '../adapters/adapter.js';
import { objectSpec } from '../adapters/adapter.js';
import type { CanonicalObject } from '../domain/canonical.js';
import type { MigrationConfig } from '../domain/config.js';
import { readCsvFileRows } from '../ingest/read-csv-file.js';
import { compareCodeUnits } from '../util/json.js';
import { IMPORT_AREA, packagePath } from '../artifacts/layout.js';
import type { Keyed } from './join.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { numberedPartPath } from '../artifacts/import-partition.js';

/**
 * Every delivered record, named and in migration-key order, one at a time.
 *
 * Several checks need to compare something the evidence says against the cell
 * an import file actually holds. Answering that with an index means holding
 * every delivered row in memory -- which is the whole dataset, and was the
 * largest structure in the verifier.
 *
 * It is not necessary. An import file's rows are in migration-key order,
 * because the crosswalk that names them is, and `import.structure` has already
 * checked it. So the files can be merged into one ascending stream of
 * `(migrationKey, row)` and walked in step with any other artifact projected
 * into the same order. What is held is one row per open file -- four at most,
 * one per object -- rather than one per record.
 *
 * The migration key comes from the crosswalk, which is read alongside, because
 * an import file in package format 2.0.0 does not say which record each of its
 * rows is. The two are checked against each other in `crosswalk.structure`;
 * here they are simply read together.
 */
export interface DeliveredRow {
  readonly path: string;
  readonly object: CanonicalObject;
  readonly row: Readonly<Record<string, string>>;
}

export function* deliveredRows(
  packageDir: string,
  adapter: DestinationAdapter,
  config: MigrationConfig,
  limits: { readonly delimiter: string; readonly maxCellLength: number; readonly maxColumns: number; readonly maxRows: number },
): IterableIterator<Keyed<DeliveredRow>> {
  const cursors = openFileCursors(packageDir, adapter, config, limits);
  try {
    for (;;) {
      let leader: FileCursor | null = null;
      for (const cursor of cursors) {
        const head = cursor.peek();
        if (head === null) continue;
        if (leader === null || compareCodeUnits(head.k, (leader.peek() as Keyed<DeliveredRow>).k) < 0) {
          leader = cursor;
        }
      }
      if (leader === null) return;
      yield leader.take() as Keyed<DeliveredRow>;
    }
  } finally {
    for (const cursor of cursors) cursor.close();
  }
}

/**
 * The files one object's import table is actually in, on disk.
 *
 * The plain name if it is there, otherwise the parts numbered from 001. This is
 * the same rule `importPartsListed` states against a manifest listing, asked of
 * the filesystem instead, because this reader is handed a directory rather than
 * a manifest. It reports what it finds and refuses nothing: the shape has
 * already been checked by `import.structure`, and a second refusal here would
 * report the same fault twice in different words.
 */
function partsOnDisk(packageDir: string, basePath: string): string[] {
  const at = (path: string): string => join(packageDir, ...path.split('/'));
  if (existsSync(at(basePath))) return [basePath];
  const parts: string[] = [];
  for (let part = 1; ; part += 1) {
    const path = numberedPartPath(basePath, part);
    if (!existsSync(at(path))) break;
    parts.push(path);
  }
  // Nothing found is not this function's fault to report: the caller opens what
  // it is given and `import.structure` has already said the file is missing.
  return parts.length > 0 ? parts : [basePath];
}

interface FileCursor {
  peek(): Keyed<DeliveredRow> | null;
  take(): Keyed<DeliveredRow> | null;
  close(): void;
}

function openFileCursors(
  packageDir: string,
  adapter: DestinationAdapter,
  config: MigrationConfig,
  limits: { readonly delimiter: string; readonly maxCellLength: number; readonly maxColumns: number; readonly maxRows: number },
): FileCursor[] {
  const cursors: FileCursor[] = [];
  for (const object of [...new Set(config.records.map((mapping) => mapping.object))]) {
    const spec = objectSpec(adapter, object);
    if (spec === null) continue;
    // One cursor per **part**. An import file larger than the destination
    // accepts is delivered as numbered parts, and this reader used to open the
    // plain name and nothing else -- so on a cut package it opened a file that
    // is not there, and the verifier died on ENOENT rather than checking
    // anything. The parts are found the same way the verifier's own listing rule
    // finds them, and the merge below is unaffected: keys ascend across the
    // parts of one object exactly as they ascend within one.
    const base = `${IMPORT_AREA}/${adapter.importDirectory}/${spec.fileName}`;
    for (const importPath of partsOnDisk(packageDir, base)) {
      cursors.push(openFileCursor(packageDir, importPath, object, limits));
    }
  }
  return cursors;
}

/**
 * One import file and the crosswalk rows that name it, read together.
 *
 * The crosswalk is read from the top for each file, and the rows for other
 * files are skipped. That is a read per import file rather than one read for
 * all of them, which is I/O in exchange for holding nothing.
 */
function openFileCursor(
  packageDir: string,
  importPath: string,
  object: CanonicalObject,
  limits: { readonly delimiter: string; readonly maxCellLength: number; readonly maxColumns: number; readonly maxRows: number },
): FileCursor {
  const rows = readCsvFileRows(join(packageDir, ...importPath.split('/')), {
    ...limits,
    filePath: importPath,
  });
  const crosswalk = readCsvFileRows(
    join(packageDir, ...packagePath('import-crosswalk.csv').split('/')),
    { ...limits, filePath: 'import-crosswalk.csv' },
  );

  let held: Keyed<DeliveredRow> | null = null;
  let exhausted = false;

  const pull = (): void => {
    if (held !== null || exhausted) return;
    const rowStep = rows.next();
    if (rowStep.done === true) {
      exhausted = true;
      return;
    }
    // The crosswalk row for this file's next line. Rows belonging to other
    // files are passed over, which is sound because the crosswalk is ordered by
    // import path and this file's rows are therefore contiguous.
    let named: Record<string, string> | null = null;
    for (;;) {
      const step = crosswalk.next();
      if (step.done === true) break;
      if ((step.value['import_path'] ?? '') !== importPath) continue;
      named = step.value;
      break;
    }
    if (named === null) {
      // The crosswalk does not account for this row. `crosswalk.structure` says
      // so in its own words; this stream has nothing to name the row with, so it
      // stops rather than inventing a key for it.
      exhausted = true;
      return;
    }
    held = {
      k: named['migration_key'] ?? '',
      v: { path: importPath, object, row: rowStep.value },
    };
  };

  return {
    peek(): Keyed<DeliveredRow> | null {
      pull();
      return held;
    },
    take(): Keyed<DeliveredRow> | null {
      pull();
      const value = held;
      held = null;
      return value;
    },
    close(): void {
      rows.return?.(undefined);
      crosswalk.return?.(undefined);
    },
  };
}

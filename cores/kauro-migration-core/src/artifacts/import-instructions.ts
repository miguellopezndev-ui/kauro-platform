import type { DestinationAdapter } from '../adapters/adapter.js';
import { objectSpec } from '../adapters/adapter.js';
import type { CanonicalObject } from '../domain/canonical.js';
import type { RelationshipType } from '../domain/associations.js';
import { relationshipShape } from '../domain/associations.js';
import type { MigrationConfig } from '../domain/config.js';
import type { Reconciliation } from '../reconcile/reconcile.js';
import type { RunTruth } from '../reconcile/truth.js';
import { compareCodeUnits } from '../util/json.js';
import { PACKAGE_FORMAT_VERSION } from '../version.js';
import { sorted } from '../util/sorting.js';
import { IMPORT_AREA } from './layout.js';
import { importPartPath } from './import-partition.js';
import { objectsNeedingImportKey } from './import-key.js';

/**
 * What the operator has to do with this package, said once and unambiguously.
 *
 * A package that is correct and unexplained still loses data, because the
 * person running the import supplies the missing half from habit: they map a
 * column that was never meant to be mapped, or pick a matching field the run
 * never matched on, and the result is a CRM that disagrees with the evidence in
 * 03_TRACEABILITY while every hash in the manifest still checks out.
 *
 * So this file names the file to import, the object, the import mode, the
 * columns, the matching field, the association strategy, the columns that must
 * not be mapped, the counts to expect afterwards, and the contract the run was
 * shaped against. It is generated from the same truth the artifacts are
 * generated from -- never written by hand -- so it cannot drift from what the
 * package actually contains.
 */
export interface InstructionsInput {
  readonly truth: RunTruth;
  readonly reconciliation: Reconciliation;
  readonly adapter: DestinationAdapter;
  readonly config: MigrationConfig;
  /**
   * How many parts each object's import file was cut into, where it was cut.
   *
   * Absent means one file each, which is the ordinary case and the one every
   * package produced before cutting existed. The instructions are the only
   * place an operator is told what to import, so a package that quietly grew a
   * second file for an object and did not say so here would be a package whose
   * own instructions are wrong.
   */
  readonly importParts?: ReadonlyMap<CanonicalObject, readonly number[]>;
}

export function renderImportInstructions(input: InstructionsInput): string {
  const { truth, reconciliation, adapter, config } = input;
  const lines: string[] = [];
  const write = (line = ''): void => {
    lines.push(line);
  };

  const keyed = objectsNeedingImportKey(config);
  const objects = sorted(
    [...new Set(config.records.map((mapping) => mapping.object))],
    compareCodeUnits,
  ) as CanonicalObject[];

  write(`# Import instructions — ${adapter.mode}`);
  write();
  write(`Run \`${truth.runId}\`, core ${truth.coreVersion}, package format ${PACKAGE_FORMAT_VERSION}.`);
  write();
  write('Import the files under `01_IMPORT/` and nothing else. Every other directory is evidence:');
  write('`02_EXCEPTIONS/` is what did not go and why, `03_TRACEABILITY/` is the record of what this run');
  write('did, and `04_DOCUMENTATION/` is this file and the audit. None of them is import input.');
  write();

  write('## What to import, in this order');
  write();
  for (const object of objects) {
    const spec = objectSpec(adapter, object);
    if (spec === null) continue;
    const base = `${IMPORT_AREA}/${adapter.importDirectory}/${spec.fileName}`;
    const parts = input.importParts?.get(object)?.length ?? 1;
    write(`### ${object} — \`${importPartPath(base, 1, parts)}\`${parts > 1 ? ` and ${String(parts - 1)} more` : ''}`);
    write();
    if (parts > 1) {
      // A cut file is still one file's worth of records, and the operator has to
      // be told that rather than left to infer it from a directory listing. The
      // order is the order: the parts are numbered because the records inside
      // them are in one sequence, and importing part three before part two would
      // put an object's records into the destination out of the order this
      // package's own traceability describes.
      write(
        `This object's import file is larger than ${adapter.mode} accepts in one file, so it is delivered in ` +
          `${String(parts)} parts. Import them all, in order:`,
      );
      write();
      for (let part = 1; part <= parts; part += 1) write(`${String(part)}. \`${importPartPath(base, part, parts)}\``);
      write();
      write(
        'Each part carries the same header row. `03_TRACEABILITY/import-crosswalk.csv` names the part each ' +
          'record went into and its row number inside that part.',
      );
      write();
    }
    write(`- Object: ${object}`);
    write(`- Import mode: ${config.target.importMode}`);
    const matching = config.destinationMatching.filter((entry) =>
      config.records.some((mapping) => mapping.id === entry.recordMappingId && mapping.object === object),
    );
    if (matching.length === 0) {
      write('- Matching field: none. Nothing in this file is matched against a record you already hold.');
    } else {
      for (const entry of matching) {
        write(
          `- Matching field: ${entry.matchAuthority}${entry.targetField === null ? '' : ` on \`${entry.targetField}\``}` +
            ` (on no match: ${entry.onMissingMatch}; on a conflicting match: ${entry.onMatchConflict})`,
        );
      }
    }
    if (keyed.has(object)) {
      write(
        `- Do not map \`${adapter.associationKeyHeader}\`. It exists only so this import can associate` +
          ' records with each other, it is not a property, and it means nothing outside this package.',
      );
    } else {
      write('- Every column in this file is a destination field. There is nothing here not to map.');
    }
    const delivered = reconciliation.records.byObject[object] ?? 0;
    write(`- Expect ${String(delivered)} records.`);
    write();
  }

  write('## Associations');
  write();
  const relationships = sorted(
    [...new Set(config.associations.map((association) => association.relationshipType as string))],
    compareCodeUnits,
  );
  if (relationships.length === 0) {
    write('This plan declares no relationships, so there is nothing to associate.');
    write();
  } else {
    for (const type of relationships) {
      const shape = relationshipShape(type as RelationshipType);
      write(
        `- \`${IMPORT_AREA}/${adapter.importDirectory}/associations/${type.toLowerCase()}.csv\`` +
          ` — ${shape.from} to ${shape.to}. Each row pairs the \`${adapter.associationFromHeader}\` value` +
          ` from the ${shape.from} file with the \`${adapter.associationToHeader}\` value from the ${shape.to} file.`,
      );
    }
    write();
    write(`Strategy: ${associationStrategy(adapter)}`);
    write();
    const associations = reconciliation.associations;
    write(
      `Expect ${String(associations.byDisposition.OUTPUT ?? 0)} relationships to be created. ` +
        `${String(associations.byDisposition.UNRESOLVED ?? 0)} could not be resolved and are listed in ` +
        '`02_EXCEPTIONS/unresolved-associations.csv` with the reason for each.',
    );
    write();
  }

  write('## What to expect afterwards');
  write();
  write(`- ${String(reconciliation.sourceRows.ingested)} source rows were read.`);
  write(`- ${String(reconciliation.records.deliveredTotal)} records are delivered across all files.`);
  write(
    `- ${String(reconciliation.sourceRows.byDisposition.ISOLATED ?? 0)} rows were set aside; each one has a` +
      ' reason in `02_EXCEPTIONS/isolated.csv`.',
  );
  write(
    `- ${String(reconciliation.cells.changed)} cell values differ from the source; every one of them is in` +
      ' `03_TRACEABILITY/changes.csv` with what it was and why it changed.',
  );
  write(
    '- A destination that reports a different number of created records than this file states means the' +
      ' import did not do what the package describes. Stop and reconcile before running anything else.',
  );
  write();

  write('## What this run was shaped against');
  write();
  write(`- Configuration hash: \`${truth.configHash}\``);
  write(`- Source bundle: \`${truth.bundleId}\``);
  write(
    `- Source profile: ${truth.sourceProfileHash === null ? 'none supplied' : `\`${truth.sourceProfileHash}\``}`,
  );
  write(
    `- Target contract: ${truth.targetContractHash === null ? 'none captured' : `\`${truth.targetContractHash}\``}`,
  );
  write();
  write(
    'If any of those differ from what you were expecting, this package is not the one you meant to import.',
  );
  write();

  return lines.join('\n');
}

function associationStrategy(adapter: DestinationAdapter): string {
  switch (adapter.mode) {
    case 'HUBSPOT':
      return (
        'run a multiple-object import. Add the association key column from the association file to both object' +
        ' files as a common column, then select it under "Common column headers found in your files". The' +
        ' column is a join key for this import only; do not map it to a property.'
      );
    case 'SALESFORCE':
      return (
        'the association files pair records by their association key. Load the parent object first, then use' +
        ' the pairing to populate the lookup field on the child, following the operation your Data Loader' +
        ' profile declares. Kauro does not fabricate a record id it has not been given.'
      );
    default:
      return (
        'nothing is imported anywhere. The association files are the delivered representation of the' +
        ' relationships, and the association key column is what pairs the rows.'
      );
  }
}

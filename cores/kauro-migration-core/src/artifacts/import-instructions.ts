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
    // One pass over the edges, tallied by type and disposition: at most three
    // types and four dispositions, whatever the size of the source.
    const tally = new Map<string, number>();
    for (const edge of truth.edges) {
      const key = `${edge.relationshipType}|${edge.disposition}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const count = (type: string, disposition: string): number => tally.get(`${type}|${disposition}`) ?? 0;
    for (const type of relationships) {
      const shape = relationshipShape(type as RelationshipType);
      const path = `${IMPORT_AREA}/${adapter.importDirectory}/associations/${type.toLowerCase()}.csv`;
      const support = adapter.relationships[type as RelationshipType];
      if (support.kind === 'UNSUPPORTED') {
        // The file exists so that the file set follows from the plan alone, and
        // it is empty by construction. Describing it like the others told an
        // operator to pair records the destination cannot relate.
        write(
          `- \`${path}\` — ${shape.from} to ${shape.to}, not supported by ${adapter.mode}: ${support.reason}` +
            ` The file is empty by design; the ${String(count(type, 'LEFTOVER'))} relationships of this type are in` +
            ' `02_EXCEPTIONS/leftovers.csv` with the reason for each.',
        );
        continue;
      }
      write(
        `- \`${path}\`` +
          ` — ${shape.from} to ${shape.to}. Each row pairs the \`${adapter.associationFromHeader}\` value` +
          ` from the ${shape.from} file with the \`${adapter.associationToHeader}\` value from the ${shape.to} file.` +
          ` ${String(count(type, 'OUTPUT'))} relationships.`,
      );
    }
    write();
    write(`Strategy: ${associationStrategy(adapter)}`);
    write();
    const associations = reconciliation.associations;
    write(
      `The association files deliver ${String(associations.byDisposition.OUTPUT ?? 0)} relationships` +
        `${adapter.mode === 'CLEAN_ONLY' ? '' : ', and they exist in the destination only once the linking step above has been carried out'}. ` +
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
  // Each sentence is a step the destination's importer is documented, or was
  // observed in the qualification campaign, to offer (N1-1, D78). 3.0.0 told a
  // HubSpot operator to choose the association key as the common column, which
  // HubSpot accepts only for a unique identifier, and a Salesforce operator to
  // "use the pairing to populate the lookup field" without saying where the
  // Salesforce Id comes from.
  switch (adapter.mode) {
    case 'HUBSPOT':
      return (
        'importing the object files alone creates the records and no association. HubSpot associates two files' +
        ' only through a common column that is a unique identifier of one of the two objects: Record ID, Email for' +
        ' contacts, Company domain name for companies, or a custom property that requires unique values. The' +
        ` \`${adapter.associationKeyHeader}\` column is not a unique identifier and is never mapped to a property;` +
        ' both object files carry a column under that header with different values, so do not select it as a' +
        ' common column. To associate the two records of a pair, copy the identifier of one of them into the' +
        " other one's row, under the header its own file uses (for a contact and its company, the company's" +
        ' `Company domain name` in the contacts file), and choose that column as the common column and as the' +
        ' unique key of that object. A pair whose records carry no such identifier cannot be associated this way.' +
        " Afterwards download the import's errors: an association HubSpot did not make is listed there with an" +
        ' error type such as' +
        ' ASSOCIATION_RECORD_NOT_FOUND, and the records are created without it.'
      );
    case 'SALESFORCE':
      return (
        'importing the object files alone creates the records and no relationship. Salesforce links a Contact or' +
        ' an Opportunity to its Account through the `AccountId` lookup, and no file here carries a Salesforce Id:' +
        ' none exists until the Accounts are loaded. Load the Account file first with Data Loader, leaving' +
        ` \`${adapter.associationKeyHeader}\` unmapped. With Data Loader's default and Bulk API (1.0) settings` +
        ' the success file starts with an `ID` column holding each new Account Id, repeats every column of the' +
        ` input row, \`${adapter.associationKeyHeader}\` included, and ends with \`STATUS\`; the error file repeats` +
        ' every column and ends with `ERROR`. The Account Id of a pair is the `ID` of the one success-file row' +
        ` whose \`${adapter.associationKeyHeader}\` is the Account side of the pair. Put it in an \`AccountId\`` +
        ' column of the child file, map that column to `AccountId`, and load the child. A child whose Account is' +
        ' in the error file, is missing from the success file, or appears there more than once has no proven Id' +
        ' and must not be linked. Kauro does not fabricate a record id it has not been given.'
      );
    default:
      return (
        'nothing is imported anywhere. The association files are the delivered representation of the' +
        ' relationships, and the association key column is what pairs the rows.'
      );
  }
}

import type { Reconciliation } from '../reconcile/reconcile.js';
import { REASON_CODES, isReasonCode } from '../domain/reason-codes.js';
import { CANONICAL_OBJECTS } from '../domain/canonical.js';

/**
 * Human-readable summary.
 *
 * This function is deliberately given the reconciliation and nothing else that
 * carries a count, so it cannot recompute a number for itself. Every figure
 * below is read out of the same object the machine artifacts were rendered
 * from, which is what lets the verifier prove the summary and the data agree.
 */
export interface AuditNotes {
  readonly instanceVerification: readonly {
    readonly scope: string;
    readonly detail: string;
    readonly sourceUrl: string;
  }[];
  readonly vendorSources: readonly {
    readonly url: string;
    readonly reviewedOn: string;
    readonly scope: string;
  }[];
  readonly adapterNotes: readonly string[];
}

export function renderAudit(reconciliation: Reconciliation, notes: AuditNotes): string {
  const rows = reconciliation.sourceRows;
  const lines: string[] = [];

  const push = (line = ''): void => {
    lines.push(line);
  };

  push('# Migration audit');
  push();
  push(`- Core version: ${reconciliation.coreVersion}`);
  push(`- Run id: ${reconciliation.runId}`);
  push(`- Bundle id: ${reconciliation.bundleId}`);
  push(`- Configuration hash: ${reconciliation.configHash}`);
  push(`- Destination: ${reconciliation.target.mode}, import mode ${reconciliation.target.importMode}`);
  push();

  push('## Every source row is accounted for');
  push();
  if (rows.equationHolds) {
    push(
      `All ${count(rows.ingested, 'source row')} read from the input files have exactly one disposition. ${String(rows.withoutDisposition)} rows disappeared.`,
    );
  } else {
    push(
      `RECONCILIATION FAILED: the readers produced ${String(rows.ingested)} rows, the lineage holds ${String(rows.total)}, and ${String(rows.accountedFor)} dispositions were assigned.`,
    );
  }
  push();
  push('| Disposition | Rows | Meaning |');
  push('| --- | ---: | --- |');
  push(`| OUTPUT | ${String(rows.byDisposition.OUTPUT)} | Delivered to the destination import files. |`);
  push(
    `| MERGED_PROVEN | ${String(rows.byDisposition.MERGED_PROVEN)} | Combined into another row proven to be the same record. |`,
  );
  push(
    `| ISOLATED | ${String(rows.byDisposition.ISOLATED)} | Understood, but not safe to import as-is. Listed in isolated.csv. |`,
  );
  push(
    `| LEFTOVER | ${String(rows.byDisposition.LEFTOVER)} | Source material the configuration does not cover. Listed in leftovers.csv. |`,
  );
  push(
    `| REJECTED_INPUT | ${String(rows.byDisposition.REJECTED_INPUT)} | Not readable as a well-formed row. Listed in rejected-input.csv. |`,
  );
  push();

  push('## Inputs');
  push();
  push(
    `${count(reconciliation.inputs.fileCount, 'file')}, ${count(reconciliation.inputs.sheetCount, 'sheet')}, ${String(reconciliation.inputs.totalByteLength)} bytes.`,
  );
  push();

  push('## Records delivered');
  push();
  push(`${count(reconciliation.records.deliveredTotal, 'record')} delivered.`);
  push();
  push('| Object | Records |');
  push('| --- | ---: |');
  // Iterated in the declared object order, never in whatever order the JSON
  // happens to hold, so the summary is byte-identical after a round trip.
  for (const object of CANONICAL_OBJECTS) {
    push(`| ${object} | ${String(reconciliation.records.byObject[object] ?? 0)} |`);
  }
  push();

  push('## Cell-level changes');
  push();
  push(
    `${count(reconciliation.cells.changed, 'cell')} changed across ${count(reconciliation.cells.rowsWithChanges, 'row')}. Every one is listed in changes.csv with its original value, its final value and the rule that produced it.`,
  );
  push(
    `${count(reconciliation.cells.clearedByExplicitAuthorization, 'value')} were cleared, all under an explicit authorization in the configuration. No other populated cell became empty.`,
  );
  push(
    `${count(reconciliation.cells.flagged, 'field')} were preserved unchanged and flagged for review in flags.csv.`,
  );
  push(
    `${count(reconciliation.cells.unmappedPreserved, 'value')} sat in columns the configuration does not map; they are preserved in unmapped-fields.csv rather than discarded.`,
  );
  push();

  push('## Identity');
  push();
  push(
    `${count(reconciliation.identity.provenMerges, 'merge')} were performed, absorbing ${count(reconciliation.identity.absorbedRows, 'row')}. A merge happens only when the source itself proves two rows are one record.`,
  );
  push(
    `${count(reconciliation.identity.duplicateCandidateClusters, 'possible-duplicate cluster')} covering ${count(reconciliation.identity.duplicateCandidateRows, 'record')} were found and left alone for review, in duplicate-candidates.csv.`,
  );
  push(
    `${count(reconciliation.identity.mergeConflicts, 'field conflict')} were recorded inside proven merges, of which ${String(reconciliation.identity.consentConflicts)} touch consent, privacy or suppression fields. No conflict was resolved by picking a winner automatically.`,
  );
  push();

  push('## Relationships');
  push();
  const edges = reconciliation.associations;
  if (edges.equationHolds) {
    push(`All ${count(edges.sourceEdges, 'source relationship')} have exactly one disposition.`);
  } else {
    push('RECONCILIATION FAILED: relationship dispositions do not close.');
  }
  push();
  push('| Disposition | Relationships |');
  push('| --- | ---: |');
  push(`| OUTPUT | ${String(edges.byDisposition.OUTPUT)} |`);
  push(`| DEDUPLICATED | ${String(edges.byDisposition.DEDUPLICATED)} |`);
  push(`| UNRESOLVED | ${String(edges.byDisposition.UNRESOLVED)} |`);
  push(`| LEFTOVER | ${String(edges.byDisposition.LEFTOVER)} |`);
  push();

  push('## Destination');
  push();
  push(
    `${count(reconciliation.destination.keyConflicts, 'destination key conflict')} were found, where records the source proves to be different would be matched to one record by the destination. They are listed in destination-conflicts.csv.`,
  );
  push(
    `${count(reconciliation.destination.spreadsheetFormulaRiskValues, 'delivered value')} begin with a character a spreadsheet application reads as a formula. The import files in 01_IMPORT hold the exact values; import them directly rather than opening them in a spreadsheet first. To read them in a spreadsheet, open the neutralised copies under 04_DOCUMENTATION/data-view, and formula-risk.csv, which are safe to open: each such value starts with an apostrophe there, and formula-risk.csv names the exact value by its SHA-256. The other CSV files carry source text exactly as written and are for tools, not spreadsheets.`,
  );
  push();

  if (notes.instanceVerification.length > 0) {
    push('## Requires verification inside the destination account');
    push();
    push(
      'These cannot be decided from files. They are stated here so nobody mistakes silence for a guarantee.',
    );
    push();
    for (const item of notes.instanceVerification) {
      push(`- **${item.scope}** — ${item.detail} (${item.sourceUrl})`);
    }
    push();
  }

  if (notes.adapterNotes.length > 0) {
    push('## Destination notes');
    push();
    for (const note of notes.adapterNotes) push(`- ${note}`);
    push();
  }

  const tally = Object.entries(reconciliation.reasonCodeTally);
  if (tally.length > 0) {
    push('## Reason codes used');
    push();
    push('| Code | Times | Meaning |');
    push('| --- | ---: | --- |');
    for (const [code, total] of tally) {
      const meaning = isReasonCode(code) ? REASON_CODES[code].description : '';
      push(`| ${code} | ${String(total)} | ${meaning} |`);
    }
    push();
  }

  if (notes.vendorSources.length > 0) {
    push('## Destination documentation used');
    push();
    for (const source of notes.vendorSources) {
      push(`- ${source.url} (reviewed ${source.reviewedOn}) — ${source.scope}`);
    }
    push();
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function count(total: number, noun: string): string {
  return `${String(total)} ${noun}${total === 1 ? '' : 's'}`;
}

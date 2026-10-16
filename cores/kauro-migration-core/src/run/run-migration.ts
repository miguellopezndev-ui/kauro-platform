import type { MigrationConfig, TargetMode } from '../domain/config.js';
import type { RowDisposition } from '../domain/disposition.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import { CoreInvariantError } from '../util/assert.js';
import { sha256Hex } from '../util/hash.js';
import { compareCodeUnits } from '../util/json.js';
import { by, onString, sorted } from '../util/sorting.js';
import { CORE_VERSION } from '../version.js';
import { getAdapter } from '../adapters/specs.js';
import type { DestinationAdapter } from '../adapters/adapter.js';
import { ingestBundle } from '../ingest/ingest-bundle.js';
import type { IngestedFile } from '../ingest/sheet.js';
import { buildRecords, rowAddress } from './build-records.js';
import { spillRecordsByRow } from './records-by-row.js';
import type { DraftRecord, DraftValue } from './build-records.js';
import { resolveIdentity } from '../identity/resolve-identity.js';
import { buildEdges, computeAssociationConsumedColumns } from '../associations/build-edges.js';
import { validateDestination, startsLikeFormula } from './validate-destination.js';
import type {
  ChangeEntry,
  ContributionKind,
  DeliveredRecord,
  EdgeEntry,
  FlagEntry,
  FormulaRiskEntry,
  IsolatedEntry,
  LeftoverEntry,
  LineageEntry,
  RejectedEntry,
  RunTruth,
  RowAddress,
  UnmappedFieldEntry,
} from '../reconcile/truth.js';
import { assertReconciliationSound, computeReconciliation } from '../reconcile/reconcile.js';
import type { Reconciliation } from '../reconcile/reconcile.js';
import { resolveMatchAuthority } from '../target/match-authority.js';
import { carriesValue, intendedValue } from '../domain/value-intent.js';
import type { HashedTargetContract } from '../target/contract.js';
import { loadTargetContract, serializeTargetContract, TARGET_CONTRACT_VERSION } from '../target/contract.js';
import { verifyAttestation } from '../target/attestation.js';
import type { AttestationAuthority, TargetAttestation } from '../target/attestation.js';
import { MigrationError } from '../domain/errors.js';
import type { HashedSourceProfile } from '../profile/source-profile.js';
import { assertProfileDescribesBundle, loadSourceProfile, serializeSourceProfile } from '../profile/source-profile.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import { openFamily, orderKey, orderNumber, rowOrderKey, rowOrderParts } from './spool.js';
import type { SpooledFamily } from './spool.js';

/**
 * What a run's mode says about attestation.
 *
 * Three values rather than two, because CLEAN_ONLY is not a lenient CRM. A
 * NOT_REQUIRED run addresses a real instance whose identity nobody is being
 * asked to vouch for; a NOT_APPLICABLE run addresses no instance at all, so
 * there is nothing for anybody to vouch for and a contract or an attestation
 * offered for it describes something the run is not doing. Collapsing the two
 * would make "no attestation was supplied" the same sentence in both cases, and
 * it is not: in one it is a gap and in the other it is the only correct state.
 *
 * NOT_REQUIRED survives as a value nothing derives. It is here so that a
 * configuration that asks for it can be named and refused rather than silently
 * reinterpreted.
 */
export type AttestationPolicy = 'REQUIRED' | 'NOT_REQUIRED' | 'NOT_APPLICABLE';

export interface RunInput {
  readonly inputRoot: string;
  readonly config: MigrationConfig;
  readonly configHash: string;
  /**
   * The captured target contract, where the run addresses a real instance.
   * Null for CLEAN_ONLY, and null for a create-only import that matches nothing.
   * Supplying one that does not describe the configured mode is refused.
   */
  readonly targetContract?: HashedTargetContract | null;
  /**
   * The policy this run is under, restated by the host where it wants to be
   * explicit about it.
   *
   * There is no default here any more. The policy is derived from the mode:
   * HUBSPOT and SALESFORCE address somebody's real portal or org, so both are
   * REQUIRED, and CLEAN_ONLY addresses no instance at all, so it is
   * NOT_APPLICABLE. MC-1 left the field defaulting to NOT_REQUIRED because
   * making the check the default was a product change rather than a bug fix;
   * this is that change.
   *
   * What is left for the host to say is a restatement, and a restatement that
   * disagrees with the mode is refused rather than honoured. NOT_REQUIRED on a
   * CRM mode is the case that matters: it is the one thing configuration must
   * never be able to do. A property export proves what properties exist and
   * says nothing about which portal produced it — this repository already
   * attributed one to the wrong portal, and no amount of care with the bytes
   * would have caught it, because the fact was not in them. A field that can
   * turn the check off is exactly how that mistake comes back, quietly, in a
   * run that looks deliberate.
   */
  readonly attestationPolicy?: AttestationPolicy;
  readonly targetAttestation?: TargetAttestation | null;
  /**
   * Issuers this deployment believes, and the key material to check them with.
   * Injected by the host. Never read from the package, the contract or the
   * attestation: a key that travels beside the claim it verifies establishes
   * nothing.
   */
  readonly attestationAuthorities?: readonly AttestationAuthority[];
  /**
   * The instant freshness is judged against, ISO 8601. Passed in rather than
   * read from the clock, so the same inputs give the same answer whenever the
   * run happens.
   */
  readonly attestationInstant?: string | null;
  /**
   * Where the run puts the facts it has finished looking at.
   *
   * Host-injected and host-owned. The run writes its row-scale families here and
   * hands back families that read from here, so the store has to outlive the
   * call: the caller disposes it once the package has been written and verified.
   * Requiring it rather than defaulting to a directory of the engine's choosing
   * is the point — a core that picks its own scratch has decided where a
   * customer's data goes.
   */
  readonly scratch: ScratchStore;
  /**
   * The profile the approved plan was compiled against, where the host has one.
   *
   * Supplying it is what lets the run refuse a stale one. A plan compiled
   * against one reading of a bundle and executed against another is a decision
   * made about data that is no longer there, and without the profile in hand
   * there is nothing either artifact could compare.
   */
  readonly sourceProfile?: HashedSourceProfile | null;
  /**
   * Bytes per read of a CSV file. The default is the one the engine runs with.
   * A smaller value changes how the file is cut and never what it says (S021,
   * S034), which is what makes it useful to a test; a host has no reason to set it.
   */
  readonly blockBytes?: number;
}

export interface RunResult {
  readonly truth: RunTruth;
  readonly reconciliation: Reconciliation;
  readonly adapter: DestinationAdapter;
}

/**
 * One deterministic pass over the source bundle.
 *
 * The order below is the contract: nothing is delivered until identity,
 * associations and destination constraints have all been settled, and the run
 * refuses to produce a package unless its own facts reconcile.
 */
export function runMigration(input: RunInput): RunResult {
  const { config } = input;
  const scratch = input.scratch;
  const adapter = getAdapter(config.target.mode);

  // Every hashed input is re-established here, at the public boundary, and a
  // private copy of it is what the run consults from now on. The hash a caller
  // hands over is a claim; the loaders recompute it from the body and refuse
  // one whose two halves disagree, and the copy is frozen so nothing the caller
  // does to its own object after this line changes what executes. Before this
  // the declared hash was taken as the name of the thing, so a profile whose
  // totals were edited and a signed contract whose field was flipped after
  // loading both ran under evidence that named different bytes (audit MC-03).
  const targetContract = verifiedTargetContract(input.targetContract ?? null);
  const sourceProfile = verifiedSourceProfile(input.sourceProfile ?? null);

  // Settled before a byte is read. What the destination will be asked to match
  // on is a property of the plan and the captured contract, not of the data, so
  // finding out it cannot be satisfied should not cost a full ingest first.
  assertTargetInstanceAttested(input, targetContract);
  const matchDecisions = resolveMatchAuthority(config, adapter, targetContract);

  const bundle = ingestBundle({
    inputRoot: input.inputRoot,
    config,
    ...(input.blockBytes === undefined ? {} : { blockBytes: input.blockBytes }),
  });

  // Checked as soon as the bundle is known and before any of it is interpreted.
  if (sourceProfile !== null) {
    assertProfileDescribesBundle(
      sourceProfile,
      bundle.bundleId,
      bundle.files.map((file) => ({ path: file.file.filePathRelative, sha256: file.file.fileSha256 })),
      config,
    );
  }

  const filesByConfigId = new Map<string, IngestedFile>();
  config.files.forEach((fileConfig, index) => {
    const ingested = bundle.files[index];
    if (ingested === undefined) {
      throw new CoreInvariantError('INGEST_FILE_ALIGNMENT', 'ingested files do not line up with the configuration');
    }
    filesByConfigId.set(fileConfig.id, ingested);
  });

  const consumedColumns = computeAssociationConsumedColumns(config, filesByConfigId);

  // The three cell-scale families are written straight through, so a changed
  // cell is recorded and released rather than collected.
  const changesOut = openFamily<ChangeEntry>(scratch, {
    schema: 'changes',
    key: (entry) => orderKey(...rowOrderParts(entry.address), entry.destinationField),
  });
  const flagsOut = openFamily<FlagEntry>(scratch, {
    schema: 'flags',
    key: (entry) => orderKey(...rowOrderParts(entry.address), entry.destinationField),
  });
  const unmappedOut = openFamily<UnmappedFieldEntry>(scratch, {
    schema: 'unmapped',
    // Row order then column, and the row number ordered as a number. It used to
    // be ordered by the row locator as text, which put row 10 before row 2 —
    // the exact thing the canonical document forbids, and invisible until a
    // sheet had ten unmapped rows in it.
    key: (entry) => orderKey(...rowOrderParts(entry.address), orderNumber(entry.columnIndex)),
  });

  // One draft per source row, and each one holds every value that row
  // produced with the column and the address it came from. Held as an array
  // this was the largest thing the run carried; written down as it is made,
  // it is one row at a time.
  //
  // Ordered by where the row came from, which is the order the rows of a
  // record are compared in.
  const draftsOut = openFamily<DraftRecord>(scratch, {
    schema: 'drafts',
    key: (draft) => rowOrderKey(draft.address),
    encode: (draft) => JSON.stringify({ ...draft, values: [...draft.values] }),
    decode: (line) => {
      const raw = JSON.parse(line) as Omit<DraftRecord, 'values'> & { values: [string, DraftValue][] };
      return { ...raw, values: new Map(raw.values) };
    },
  });

  buildRecords({
    config,
    filesByConfigId,
    consumedColumns,
    booleanText: adapter.booleanText,
    out: { changes: changesOut, flags: flagsOut, unmappedFields: unmappedOut, drafts: draftsOut },
  });

  const drafts = draftsOut.seal();
  const identity = resolveIdentity(drafts, config.policies, bundle.bundleId, scratch);
  // The drafts are spent. Identity resolution is the only stage that ever read
  // them, and it reads them exactly twice: once to collect the identity keys
  // every row holds, and once to re-key each draft under the component that
  // grouping put it in. Both reads are inside `resolveIdentity`, and it has
  // returned, so the last reader is behind us. What the run carries forward is
  // the records family, which is what the drafts were turned into.
  drafts.release();
  const destination = validateDestination(identity.records, config, adapter, scratch, targetContract);
  // Which record each source row went into, written down once and walked
  // alongside each sheet rather than held as a map of every record.
  const recordsByRow = spillRecordsByRow(scratch, destination.records);

  const associations = buildEdges({
    config,
    filesByConfigId,
    recordsByRow,
    adapter,
    scratch,
  });

  // The relationships each source row declares, written down under that row
  // and walked alongside the sheets. A map from every row to its edges was one
  // entry per relationship, held for the rest of the run.
  const edgesByRowOut = openFamily<EdgeEntry>(scratch, {
    schema: 'edges-by-row',
    key: (edge) => orderKey(...rowOrderParts(edge.address), edge.sourceEdgeId),
  });
  for (const edge of associations.edges) edgesByRowOut.add(edge);
  const edgesByRow = edgesByRowOut.seal();

  // Written as they are produced, in the order the artifacts declare, and read
  // back a record at a time. These four used to be arrays that were pushed to
  // for the length of the run and then copied to sort — at a million rows, four
  // full-size copies of the migration made and held at the moment the process
  // was already holding the most.
  const lineageOut = openFamily<LineageEntry>(scratch, {
    schema: 'lineage',
    key: (entry) => rowOrderKey(entry.address),
  });
  const isolatedOut = openFamily<IsolatedEntry>(scratch, {
    schema: 'isolated',
    key: (entry) => rowOrderKey(entry.address),
  });
  const leftoversOut = openFamily<LeftoverEntry>(scratch, {
    schema: 'leftovers',
    key: (entry) => rowOrderKey(entry.address),
  });
  const rejectedOut = openFamily<RejectedEntry>(scratch, {
    schema: 'rejected',
    key: (entry) => rowOrderKey(entry.address),
  });

  for (const file of bundle.files) {
    for (const sheet of file.sheets) {
      const sheetKey = `${file.file.fileId}:${sheet.sheet.sheetId}`;
      const associationOnly = associations.associationOnlySheets.has(sheetKey);

      for (const rejectedRow of sheet.rejectedRows) {
        const address = rowAddress(file, sheet, rejectedRow.locator);
        lineageOut.add(emptyLineage(address, 'NONE', 'REJECTED_INPUT', rejectedRow.reasonCode, rejectedRow.detail));
        rejectedOut.add({ address, reasonCode: rejectedRow.reasonCode, detail: rejectedRow.detail });
      }

      // A cursor per sheet: the records and the relationships are written in
      // the order every sheet is walked in, so all three run alongside each
      // other and nothing is indexed.
      const recordsHere = recordsByRow.open();
      const edgesHere = openEdgeCursor(edgesByRow);

      for (const row of sheet.rows) {
        const address = rowAddress(file, sheet, row.locator);
        const record = recordsHere.at(address);

        if (record !== null) {
          const isSurvivor = record.survivor.rowLocatorId === row.locator.rowLocatorId;
          // The entry names the member this row is. A row that is not the
          // one the entry names means the walk and the family have come apart.
          const member = record.member;
          if (member.rowLocatorId !== row.locator.rowLocatorId) {
            throw new CoreInvariantError('LINEAGE_MEMBER_PRESENT', 'a resolved record lost one of its member rows', {
              rowLocatorId: row.locator.rowLocatorId,
            });
          }

          let disposition: RowDisposition;
          let reasonCode: ReasonCode;
          let detail: string;

          if (!isSurvivor) {
            // A row absorbed by a proven merge keeps that disposition whatever
            // happens to the record afterwards. The record's fate belongs to
            // its surviving row, so the two partitions never double-count.
            disposition = 'MERGED_PROVEN';
            reasonCode = 'IDENTITY_ROW_ABSORBED_BY_PROVEN_MERGE';
            detail = `combined into ${record.survivor.rowLocatorId} by merge ${record.mergeId ?? 'unknown'}`;
          } else if (record.isolation !== null) {
            disposition = 'ISOLATED';
            reasonCode = record.isolation.reasonCode;
            detail = record.isolation.detail;
            // How many rows the record absorbed is the membership, which is
            // written once under the survivor and asked for at its row.
            const absorbed = (recordsHere.membersAt(address)?.length ?? 1) - 1;
            isolatedOut.add({
              address,
              object: record.object,
              recordMappingId: record.recordMappingId,
              reasonCode,
              field: record.isolation.field ?? null,
              detail:
                absorbed > 0 ? `${detail} (this record also absorbed ${String(absorbed)} other row(s))` : detail,
            });
          } else {
            disposition = 'OUTPUT';
            reasonCode = 'INGEST_ROW_ACCEPTED';
            detail = 'delivered as a destination record';
          }

          lineageOut.add({
            address,
            contributionKind: 'RECORD',
            disposition,
            reasonCode,
            detail,
            recordMappingId: member.recordMappingId,
            object: record.object,
            sourceSystem: member.sourceSystem,
            sourceNamespace: member.sourceNamespace,
            sourceRecordId: member.sourceRecordId,
            identityKey: member.identityKey,
            recordIdentityKey: record.canonicalIdentityKey,
            migrationKey: record.migrationKey,
            mergeId: record.mergeId,
          });
          continue;
        }

        if (associationOnly) {
          const rowEdges = edgesHere.at(address);
          const decision = decideAssociationRow(rowEdges);
          lineageOut.add(emptyLineage(address, 'ASSOCIATION', decision.disposition, decision.reasonCode, decision.detail));
          if (decision.disposition === 'ISOLATED') {
            isolatedOut.add({
              address,
              object: null,
              recordMappingId: null,
              reasonCode: decision.reasonCode,
              field: null,
              detail: decision.detail,
            });
          } else if (decision.disposition === 'LEFTOVER') {
            leftoversOut.add({ address, reasonCode: decision.reasonCode, detail: decision.detail });
          }
          continue;
        }

        const detail = `no record mapping covers ${file.file.filePathRelative}${sheet.sheet.sheetName === null ? '' : `!${sheet.sheet.sheetName}`}`;
        lineageOut.add(emptyLineage(address, 'NONE', 'LEFTOVER', 'LEFTOVER_NO_RECORD_MAPPING', detail));
        leftoversOut.add({ address, reasonCode: 'LEFTOVER_NO_RECORD_MAPPING', detail });
      }
    }
  }

  const deliveredOut = openFamily<DeliveredRecord>(scratch, {
    schema: 'delivered',
    key: (record) => record.migrationKey,
  });
  for (const record of destination.records) {
    if (record.isolation !== null) continue;
    const fields = sorted([...record.values.entries()], by(onString(([name]) => name)));
    deliveredOut.add({
      migrationKey: record.migrationKey,
      object: record.object,
      recordMappingId: record.recordMappingId,
      survivorRowLocatorId: record.survivor.address.rowLocatorId,
      memberRowLocatorIds: record.members.map((member) => member.address.rowLocatorId),
      sourceSystem: record.survivor.sourceSystem,
      sourceNamespace: record.survivor.sourceNamespace,
      sourceRecordId: record.survivor.sourceRecordId,
      // Two questions, asked separately, because one map could only answer one
      // of them. A field with no value used to be dropped here, and a clear has
      // no value, so an authorized clear left the run as an omission and the
      // import file promised nothing.
      values: Object.fromEntries(
        fields
          .filter(([, resolved]) => carriesValue(resolved.intent))
          .map(([name, resolved]) => [name, intendedValue(resolved.intent) as string]),
      ),
      clearedFields: fields
        .filter(([, resolved]) => resolved.intent.kind === 'CLEAR')
        .map(([name]) => name),
    });
  }

  // The values a spreadsheet would read as a formula, written out as they are
  // settled rather than concatenated and sorted afterwards.
  //
  // The edges are no longer written a second time here. This loop used to open
  // its own 'edges' family, keyed by sourceEdgeId, and copy every edge of
  // `associations.edges` into it -- which buildEdges had already written under
  // exactly that key, with the same encoder, and sealed. Re-sorting an already
  // sorted family by its own key reproduces it byte for byte (the sort's tie
  // break is input position, and the input was that order), so the second
  // segment was a copy of the first under the same name: two segments of the
  // 'edges' family, one of them read by nothing. The walk stays, because the
  // formula risks are still collected from it.
  const formulaRisksOut = openFamily<FormulaRiskEntry>(scratch, {
    schema: 'formula-risks',
    key: (entry) => orderKey(entry.target, entry.migrationKey, entry.destinationField),
  });
  for (const entry of destination.formulaRisks) formulaRisksOut.add(entry);
  for (const edge of associations.edges) {
    // An association label can come from a source column, so it is data and gets
    // the same treatment a delivered field value gets. Association files used to
    // be exempt from the whole rule.
    if (edge.disposition === 'OUTPUT' && edge.label !== null && startsLikeFormula(edge.label)) {
      formulaRisksOut.add({
        target: adapter.mode,
        object: 'ASSOCIATION',
        migrationKey: edge.sourceEdgeId,
        destinationField: 'association.label',
        value: edge.label,
        reasonCode: 'DESTINATION_FORMULA_RISK_VALUE',
      });
    }
  }

  // The relationships an absorbed row declared, gathered in one walk of the
  // edges rather than by scanning them once per merge. A merge is bounded by
  // the rows it absorbed, so what is held is bounded by what the merges say.
  const remapsByRow = new Map<string, { sourceEdgeId: string; fromRowLocatorId: string; toMigrationKey: string }[]>();
  const absorbedRows = new Set(identity.merges.flatMap((merge) => merge.absorbedRowLocatorIds));
  if (absorbedRows.size > 0) {
    for (const edge of associations.edges) {
      if (edge.disposition !== 'OUTPUT' && edge.disposition !== 'DEDUPLICATED') continue;
      const rowId = edge.address.rowLocatorId;
      if (!absorbedRows.has(rowId)) continue;
      const bucket = remapsByRow.get(rowId) ?? [];
      bucket.push({
        sourceEdgeId: edge.sourceEdgeId,
        fromRowLocatorId: rowId,
        toMigrationKey: edge.toMigrationKey ?? '',
      });
      remapsByRow.set(rowId, bucket);
    }
  }
  const merges = identity.merges.map((merge) => ({
    ...merge,
    associationRemaps: merge.absorbedRowLocatorIds.flatMap((rowId) => remapsByRow.get(rowId) ?? []),
  }));

  const runId = `run_${sha256Hex(
    [
      CORE_VERSION,
      input.configHash,
      ...sorted(bundle.files.map((file) => file.file.fileSha256), compareCodeUnits),
    ].join('\n'),
  ).slice(0, 24)}`;

  const truth: RunTruth = {
    coreVersion: CORE_VERSION,
    bundleId: bundle.bundleId,
    runId,
    configHash: input.configHash,
    mode: adapter.mode,
    importMode: config.target.importMode,
    targetContractHash: targetContract?.contractHash ?? null,
    // The reading of the source this run was authorised against, or null where
    // the host supplied none. Recorded so a package states which profile it
    // belongs to rather than leaving a reader to assume.
    sourceProfileHash: sourceProfile?.profileHash ?? null,
    destinationMatching: sorted(
      matchDecisions.map((decision) => {
        const declared = config.destinationMatching.find(
          (entry) => entry.recordMappingId === decision.recordMappingId,
        );
        return {
          recordMappingId: decision.recordMappingId,
          matchAuthority: decision.matchAuthority,
          targetField: decision.targetField,
          sourceField: decision.sourceField,
          onMissingMatch: declared?.onMissingMatch ?? 'ISOLATE',
          onMatchConflict: declared?.onMatchConflict ?? 'ISOLATE',
          authorisedBy: describeAuthority(decision),
        };
      }),
      by(onString((entry) => entry.recordMappingId)),
    ),
    sourceFiles: bundle.files.map((file) => ({
      fileId: file.file.fileId,
      path: file.file.filePathRelative,
      sha256: file.file.fileSha256,
      byteLength: file.file.fileByteLength,
      format: file.file.format,
      encoding: file.file.encoding,
      encodingEvidence: file.file.encodingEvidence,
      sheets: file.sheets.map((sheet) => ({
        sheetId: sheet.sheet.sheetId,
        sheetName: sheet.sheet.sheetName,
        hidden: sheet.sheet.hidden,
        columnCount: sheet.columns.length,
        readerRowCount: sheet.readerRowCount,
        dataRowCount: sheet.dataRowCount,
        rejectedRowCount: sheet.rejectedRows.length,
        evidence: sheet.evidence.map((item) => ({ kind: item.kind, detail: item.detail })),
      })),
    })),
    lineage: lineageOut.seal(),
    changes: changesOut.seal(),
    flags: flagsOut.seal(),
    unmappedFields: unmappedOut.seal(),
    isolated: isolatedOut.seal(),
    leftovers: leftoversOut.seal(),
    rejected: rejectedOut.seal(),
    merges: sorted(merges, by(onString((merge) => merge.mergeId))),
    duplicateCandidates: identity.duplicateCandidates,
    duplicateCandidateClusters: identity.duplicateCandidateClusters,
    duplicateCandidateRows: identity.duplicateCandidateRows,
    edges: associations.edges,
    edgeCandidateCount: associations.candidateCount,
    destinationConflicts: destination.conflicts,
    instanceVerification: destination.instanceVerification,
    deliveredRecords: deliveredOut.seal(),
    // One declared order over the whole file: record risks and association-label
    // risks were concatenated, each sorted within itself, which is not an order.
    formulaRisks: formulaRisksOut.seal(),
  };

  const reconciliation = computeReconciliation(truth);
  assertReconciliationSound(truth, reconciliation, scratch);

  // The bundle is not handed back.
  //
  // It was, and every caller that held the result held every decoded source row
  // with it — through the package write, through verification, through the
  // whole longest stage of a run. Nothing needed it: the truth carries what the
  // package is made of, and the caller that wanted eight numbers took eight
  // numbers. Returning it made releasing it somebody else's job, and the CLI
  // had a comment explaining that it set its own variable to null to get around
  // exactly this.
  return { truth, reconciliation, adapter };
}

/**
 * What the mode says about attestation, before anything else is consulted.
 *
 * Derived rather than defaulted, and that is the whole point. A default is a
 * value a caller gets for not having thought about the question, and every
 * caller that had not thought about attestation used to get the permissive
 * answer: the run went ahead against somebody's live portal on the strength of
 * a capture nobody had vouched for. The mode already carries the fact that
 * settles it — whether there is an instance at the other end — so the policy is
 * read off the mode and there is no answer for a caller to omit.
 *
 * CLEAN_ONLY is NOT_APPLICABLE rather than NOT_REQUIRED. It has no portal and
 * no org behind it, nothing to pre-create and no import wizard reading the
 * result, so an attestation offered for it is not a precaution that happens to
 * be unnecessary; it is a claim about something the run is not addressing.
 */
export function attestationPolicyFor(mode: TargetMode): AttestationPolicy {
  switch (mode) {
    case 'HUBSPOT':
    case 'SALESFORCE':
      return 'REQUIRED';
    case 'CLEAN_ONLY':
      return 'NOT_APPLICABLE';
  }
}

/**
 * Refuse an instance nobody outside this run has vouched for.
 *
 * Checked before a byte is read, because whether the destination may be touched
 * at all is a property of the plan and the evidence, not of the data — finding
 * out that it may not should not cost a full ingest first.
 *
 * Configuration may restate the policy the mode derives and may not replace it.
 * That asymmetry is deliberate: narrowing a policy is a decision to be more
 * careful, which the host is entitled to make, while widening one is a decision
 * that the evidence this seam exists to demand is not needed after all, which
 * is the failure the seam exists to prevent. Since REQUIRED is already the
 * strictest a CRM run can be and NOT_APPLICABLE is already the strictest
 * CLEAN_ONLY can be, there is nothing left to narrow to, so an explicit policy
 * that is not the derived one is a contradiction and is named as one.
 *
 * Every path here fails closed. A stated policy that disagrees with the mode,
 * an absent attestation, an empty authority list under REQUIRED, a contract or
 * an attestation handed to a run that addresses no instance, and a signature
 * that does not verify are all the same answer: what the run was asked to do
 * and what it was given do not agree, so the run stops.
 */
function assertTargetInstanceAttested(input: RunInput, targetContract: HashedTargetContract | null): void {
  const mode = input.config.target.mode;
  const policy = attestationPolicyFor(mode);
  const stated = input.attestationPolicy ?? policy;

  if (policy === 'REQUIRED' && stated !== 'REQUIRED') {
    throw new MigrationError(
      'CONFIG_INVALID',
      `a ${mode} run addresses a real instance, so its attestation policy is REQUIRED, and the configuration asked for ${stated}`,
      'Remove attestationPolicy, or set it to REQUIRED, and supply an attestation from an issuer this deployment accepts. Configuration cannot turn this check off: a captured export proves which properties exist and never which instance produced it, so a run that skips the attestation has taken somebody\'s word for whose portal it is about, which is the mistake this check exists to catch.',
      { mode, derivedPolicy: policy, statedPolicy: stated },
    );
  }

  if (policy === 'NOT_APPLICABLE' && stated !== 'NOT_APPLICABLE') {
    throw new MigrationError(
      'CONFIG_INVALID',
      `a ${mode} run addresses no destination instance, so its attestation policy is NOT_APPLICABLE, and the configuration asked for ${stated}`,
      'Remove attestationPolicy from this run. CLEAN_ONLY produces cleaned files and imports nothing, so there is no instance for an attestation to be required of, and none for it to be excused from either.',
      { mode, derivedPolicy: policy, statedPolicy: stated },
    );
  }

  if (policy === 'NOT_APPLICABLE') {
    // A contract describes an instance and an attestation vouches for one, so
    // either of them arriving with a run that addresses no instance means the
    // run and its evidence disagree about what is being done. Ignoring them
    // quietly is the tempting reading — nothing here would consult them anyway
    // — and it is the wrong one: the likeliest way to get here is a plan
    // written for a portal executed with its mode changed to CLEAN_ONLY, and
    // that run should stop and be looked at rather than produce a package that
    // looks deliberate.
    if (targetContract !== null) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `a ${mode} run addresses no destination instance and this one was given a target contract describing ${targetContract.contract.instance.mode} instance ${targetContract.contract.instance.instanceId}`,
        'Either run this plan in the mode the contract describes, or remove the target contract. A contract states what a destination instance holds, and a clean-only run has no destination instance.',
        {
          mode,
          contractMode: targetContract.contract.instance.mode,
          contractInstanceId: targetContract.contract.instance.instanceId,
          contractHash: targetContract.contractHash,
        },
      );
    }

    const offered = input.targetAttestation ?? null;
    if (offered !== null) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `a ${mode} run addresses no destination instance and this one was given an attestation from "${offered.issuer.id}" about ${offered.subject.mode} instance ${offered.subject.instanceId}`,
        'Either run this plan in the mode the attestation is about, or remove the attestation. It vouches for an instance, and a clean-only run addresses none, so there is nothing here for it to vouch for.',
        {
          mode,
          issuerId: offered.issuer.id,
          attestedMode: offered.subject.mode,
          attestedInstanceId: offered.subject.instanceId,
        },
      );
    }

    return;
  }

  if (targetContract === null) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `a ${mode} run requires an attested target instance and this one was given no target contract`,
      'Capture the target schema from the destination instance, have it attested, and supply both with the run.',
      { mode, attestationPolicy: policy },
    );
  }

  // The configured mode and the contract's mode are compared here, before the
  // signature is consulted, and the attestation is then required to vouch for
  // the configured mode rather than for whatever the contract says about
  // itself. A valid signature over a SALESFORCE contract used to satisfy a
  // HUBSPOT run, because the expected mode was read off the contract that was
  // being checked (audit MC-01).
  if (targetContract.contract.instance.mode !== mode) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `a ${mode} run was given a target contract describing ${targetContract.contract.instance.mode} instance ${targetContract.contract.instance.instanceId}`,
      'Supply the target contract captured from the instance this run is addressed to, and the attestation that covers it. A contract for another destination proves nothing about this one, however well it is signed.',
      {
        mode,
        contractMode: targetContract.contract.instance.mode,
        contractInstanceId: targetContract.contract.instance.instanceId,
        contractHash: targetContract.contractHash,
      },
    );
  }

  const authorities = input.attestationAuthorities ?? [];
  if (authorities.length === 0) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `a ${mode} run requires an attested target instance and no issuer key material was supplied`,
      'Supply the public key material for the issuers this deployment accepts. The core holds no keys of its own, and a key carried by the attestation it verifies would establish nothing.',
      { mode, attestationPolicy: policy, authorities: 0 },
    );
  }

  const verification = verifyAttestation({
    attestation: input.targetAttestation ?? null,
    publicKeys: authorities,
    expect: {
      mode,
      instanceId: targetContract.contract.instance.instanceId,
      contractHash: targetContract.contractHash,
      artifacts: targetContract.contract.artifacts.map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
      })),
      at: input.attestationInstant ?? '',
    },
  });

  if (!verification.ok) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `the target instance is not attested: ${verification.reasons.join('; ')}`,
      'A captured export proves which properties exist. It does not prove which instance produced it. Obtain an attestation from an issuer this deployment accepts, covering this contract and these artifacts, and supply it with the run.',
      {
        issuerId: verification.issuerId,
        keyId: verification.keyId,
        reasons: verification.reasons.join('; '),
        contractHash: targetContract.contractHash,
      },
    );
  }
}

/**
 * Freeze a value and everything reachable from it.
 *
 * The verified inputs are copies the run made for itself, so freezing them
 * costs nobody anything and makes a later write throw in strict code rather
 * than change what the run is bound to.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The contract the run is bound to: shape, version and digest re-established
 * from the body, and a frozen copy handed back.
 *
 * Round-tripping through the loader is deliberate. It is the one reader that
 * already refuses a contract whose body and digest disagree, and using it here
 * means a caller who builds a HashedTargetContract in memory is held to the
 * same standard as one who reads it off disk.
 */
function verifiedTargetContract(supplied: HashedTargetContract | null): HashedTargetContract | null {
  if (supplied === null) return null;
  if (typeof supplied !== 'object' || supplied.contract === null || typeof supplied.contract !== 'object') {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      'the supplied target contract is not a hashed target contract',
      'Supply the contract the capture produced, with its contractHash intact.',
      {},
    );
  }
  const verified = loadTargetContract(serializeTargetContract(supplied), 'the supplied target contract');
  if (verified.contract.contractVersion !== TARGET_CONTRACT_VERSION) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `the supplied target contract declares version ${String(verified.contract.contractVersion)} and this core reads ${TARGET_CONTRACT_VERSION}`,
      'Recapture the target schema with this core version.',
      { declared: String(verified.contract.contractVersion), contractHash: verified.contractHash },
    );
  }
  if (typeof supplied.canonicalJson === 'string' && supplied.canonicalJson !== verified.canonicalJson) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      'the supplied target contract carries canonical bytes that are not the bytes of its body',
      'Supply the contract exactly as the capture produced it. A contract whose recorded bytes and body disagree has been edited since it was named.',
      { contractHash: verified.contractHash },
    );
  }
  return deepFreeze(verified);
}

/**
 * The profile the run is bound to, re-read the way a file would be: schema,
 * invariants and digest all recomputed from the body, and a frozen copy handed
 * back. A replaced hash and an edited total are both refused here, before the
 * source is opened.
 */
function verifiedSourceProfile(supplied: HashedSourceProfile | null): HashedSourceProfile | null {
  if (supplied === null) return null;
  if (typeof supplied !== 'object' || supplied.profile === null || typeof supplied.profile !== 'object') {
    throw new MigrationError(
      'SOURCE_PROFILE_INVALID',
      'the supplied source profile is not a hashed source profile',
      'Supply the profile the profiler produced, with its profileHash intact.',
      {},
    );
  }
  return deepFreeze(loadSourceProfile(serializeSourceProfile(supplied), 'the supplied source profile'));
}

/**
 * Why the engine was willing to match on this field.
 *
 * The package says it out loud so that a reader does not have to re-derive it
 * from the contract, and so that a package produced under a rule that later
 * changes still records the rule it was produced under.
 */
function describeAuthority(decision: { matchAuthority: string; resolvedField: { unique: string; externalId: string; idLookup: string } | null }): string {
  if (decision.matchAuthority === 'NONE') return 'nothing is matched';
  if (decision.matchAuthority === 'RECORD_ID') return 'the destination record id';
  const field = decision.resolvedField;
  if (field === null) return 'unrecorded';
  const held = [
    field.externalId === 'TRUE' ? 'externalId' : null,
    field.unique === 'TRUE' ? 'unique' : null,
    field.idLookup === 'TRUE' ? 'idLookup' : null,
  ].filter((name): name is string => name !== null);
  return held.length === 0 ? 'unrecorded' : `the captured contract reports ${held.join(', ')}`;
}

/**
 * The relationships one source row declares, walked alongside the sheet.
 *
 * The family is written under the row each relationship came from, in the
 * order every sheet is walked in, so the edges for a row are the run of
 * entries at that row and only that run is held. A map from every row to its
 * edges used to stand here.
 */
function openEdgeCursor(edges: SpooledFamily<EdgeEntry>): { at(address: RowAddress): EdgeEntry[] } {
  const rows = edges[Symbol.iterator]();
  let held: EdgeEntry | null = null;
  let exhausted = false;

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
    at(address: RowAddress): EdgeEntry[] {
      const wanted = rowOrderKey(address);
      const found: EdgeEntry[] = [];
      for (;;) {
        pull();
        if (held === null) return found;
        const here = rowOrderKey(held.address);
        const order = compareCodeUnits(here, wanted);
        if (order > 0) return found;
        const edge = held;
        held = null;
        if (order === 0) found.push(edge);
      }
    },
  };
}

function decideAssociationRow(edges: readonly EdgeEntry[]): {
  disposition: RowDisposition;
  reasonCode: ReasonCode;
  detail: string;
} {
  const delivered = edges.find((edge) => edge.disposition === 'OUTPUT' || edge.disposition === 'DEDUPLICATED');
  if (delivered !== undefined) {
    // A deduplicated relationship is still this row's relationship: it is
    // delivered, once, through another row's edge. Naming that edge is the
    // difference between a useful pointer and one that leads nowhere.
    const deliveringEdgeId = delivered.deduplicatedIntoEdgeId ?? delivered.sourceEdgeId;
    return {
      disposition: 'OUTPUT',
      reasonCode: delivered.reasonCode,
      detail:
        delivered.disposition === 'DEDUPLICATED'
          ? `this relationship is delivered once, as ${deliveringEdgeId}`
          : `delivered as relationship ${deliveringEdgeId}`,
    };
  }
  const unresolved = edges.find((edge) => edge.disposition === 'UNRESOLVED');
  if (unresolved !== undefined) {
    return { disposition: 'ISOLATED', reasonCode: unresolved.reasonCode, detail: unresolved.detail };
  }
  const leftover = edges[0];
  if (leftover !== undefined) {
    return { disposition: 'LEFTOVER', reasonCode: leftover.reasonCode, detail: leftover.detail };
  }
  return {
    disposition: 'LEFTOVER',
    reasonCode: 'LEFTOVER_ASSOCIATION_SHEET_ONLY',
    detail: 'this relationship sheet row produced no relationship',
  };
}

function emptyLineage(
  address: LineageEntry['address'],
  contributionKind: ContributionKind,
  disposition: RowDisposition,
  reasonCode: ReasonCode,
  detail: string,
): LineageEntry {
  return {
    address,
    contributionKind,
    disposition,
    reasonCode,
    detail,
    recordMappingId: null,
    object: null,
    sourceSystem: null,
    sourceNamespace: null,
    sourceRecordId: null,
    identityKey: null,
    recordIdentityKey: null,
    migrationKey: null,
    mergeId: null,
  };
}

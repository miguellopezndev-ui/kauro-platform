#!/usr/bin/env node
// Sabotage harness.
//
// Targeted mutations, each one a way the engine could plausibly break
// the contract. For each, the source is edited, rebuilt and the full suite is
// run: the mutation is only "killed" if the suite goes red. A mutation that
// survives means the suite is not actually checking the thing it claims to.
//
// Every anchor is checked before the first mutation runs, and every mutation is
// applied to a copy of the working tree rather than to the working tree. No git
// command is ever run. See the note on `workRoot` below for why the copy exists:
// a `finally` restores a file when the process finishes and does not when it is
// killed, and this harness has twice left a mutation behind in a tree somebody
// was working in.
//
//   node tools/sabotage.mjs                 every mutation, in a copy
//   node tools/sabotage.mjs --only M61,M80  a named subset, for re-proving one
//   node tools/sabotage.mjs --in-place      mutate this tree; a disposable checkout only
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Where the mutations are actually applied.
 *
 * Not the tree you are working in. This harness edits real source files, and
 * for the length of a run the tree it edits is intermittently wrong — a build
 * from it is a build of a defect, a test against it is a test of a defect, and
 * a `git add` during it stages one. That has happened twice here. The first
 * time a commit captured `run-migration.ts` mid-mutation and shipped real row
 * loss to main: three rows read, two accounted for. The second time a gate ran
 * this harness as a child while other work was in flight, and killing it left
 * an audit summary in the tree reporting "0 rows disappeared" from a count that
 * could not see disappearances.
 *
 * Both were the same mistake, and it is not one that care fixes: the harness
 * has always restored every file in a `finally`, and a `finally` does not run
 * when a process is killed. So the mutations happen somewhere else now. What is
 * copied is the working tree rather than a commit, because what is being tested
 * is the code as it stands, not the code as it was last committed.
 */
const inPlace = process.argv.includes('--in-place');
const workRoot = inPlace ? sourceRoot : join(sourceRoot, 'tmp', 'sabotage-tree');

// Everything the build and the suite read. `node_modules` is linked rather than
// copied: it is hundreds of megabytes, nothing mutates it, and copying it would
// cost more than the run it protects.
const COPIED = ['src', 'tools', 'test', 'spec', 'acceptance', 'qualification', 'package.json', 'tsconfig.json'];

function prepareWorkTree() {
  if (inPlace) return;
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  for (const entry of COPIED) {
    const from = join(sourceRoot, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(workRoot, entry), { recursive: true });
  }
  try {
    symlinkSync(join(sourceRoot, 'node_modules'), join(workRoot, 'node_modules'), 'junction');
  } catch {
    // A filesystem that will not make the link gets the copy, which is slow and
    // correct. Failing here would be failing for a reason with nothing to do
    // with the engine.
    cpSync(join(sourceRoot, 'node_modules'), join(workRoot, 'node_modules'), { recursive: true });
  }
}

function disposeWorkTree() {
  if (inPlace) return;
  rmSync(workRoot, { recursive: true, force: true });
}

// A signal is the case a `finally` cannot cover, and the case that has twice
// left a mutation behind. With the work happening in a copy there is nothing to
// restore, so this only tidies up.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    disposeWorkTree();
    process.exit(130);
  });
}

const repoRoot = workRoot;

/**
 * `from` must appear exactly once in the file. `to` must still compile: a
 * mutation that does not build is not a test of anything.
 *
 * This harness rebuilds `dist/` for every mutation, so nothing else may build
 * or run tests while it does. A concurrent `npm test` reads whichever mutated
 * build happens to be on disk and reports failures that belong to a mutation
 * rather than to the code.
 */
const MUTATIONS = [
  {
    id: 'M01',
    title: 'an ambiguous value is delivered as empty',
    contract: 'CONTRACT.md 2 and 4',
    file: 'src/transform/apply.ts',
    from: '      // Preserve the source value exactly, including any whitespace.\n      return build(step.kind, raw, step.reasonCode, evidence);',
    to: '      return build(step.kind, null, step.reasonCode, evidence);',
  },
  {
    id: 'M02',
    title: 'the non-destruction guard is removed and ambiguous values are cleared',
    contract: 'CONTRACT.md 2',
    files: [
      {
        file: 'src/domain/transform.ts',
        from: '    const authorized =\n      draft.kind === \'CLEAR_EXPLICIT\' && safetyClass === \'DESTRUCTIVE_EXPLICITLY_AUTHORIZED\';',
        to: '    const authorized = true;',
      },
      {
        file: 'src/transform/apply.ts',
        from: '      // Preserve the source value exactly, including any whitespace.\n      return build(step.kind, raw, step.reasonCode, evidence);',
        to: '      return build(step.kind, null, step.reasonCode, evidence);',
      },
    ],
  },
  {
    id: 'M03',
    title: 'a shared email address is treated as proof of identity',
    contract: 'CONTRACT.md 7',
    file: 'src/identity/resolve-identity.ts',
    from: '    for (const item of draft.identityKeys) holders.add({ key: item.key, row: index });',
    to: "    const emailKey = intendedValue(draft.values.get('contact.email')?.intent ?? omit('NO_VALUE_PRODUCED'));\n    for (const item of draft.identityKeys) holders.add({ key: item.key, row: index });\n    if (emailKey !== null && emailKey.length > 0) holders.add({ key: `email|${emailKey}`, row: index });",
  },
  {
    id: 'M04',
    title: 'a shared full name is treated as proof of identity',
    contract: 'CONTRACT.md 7',
    file: 'src/identity/resolve-identity.ts',
    from: '    for (const item of draft.identityKeys) holders.add({ key: item.key, row: index });',
    to: "    const nameKey = `${intendedValue(draft.values.get('contact.firstName')?.intent ?? omit('NO_VALUE_PRODUCED')) ?? ''} ${intendedValue(draft.values.get('contact.lastName')?.intent ?? omit('NO_VALUE_PRODUCED')) ?? ''}`;\n    for (const item of draft.identityKeys) holders.add({ key: item.key, row: index });\n    if (nameKey.trim().length > 0) holders.add({ key: `name|${nameKey}`, row: index });",
  },
  {
    id: 'M05',
    title: 'source namespaces are dropped from the identity key',
    contract: 'CONTRACT.md 7',
    file: 'src/domain/identity.ts',
    from: '    key.sourceNamespace,\n    key.identitySpace,',
    to: "    '',\n    key.identitySpace,",
  },
  {
    id: 'M06',
    title: 'one input row is quietly dropped during ingest',
    contract: 'CONTRACT.md 1',
    file: 'src/ingest/ingest-bundle.ts',
    from: '    readerRowCount += 1;',
    to: '    readerRowCount += 1;\n    if (recordNumber === 3) return;',
  },
  {
    id: 'M07',
    title: 'an absorbed row is left out of the lineage',
    contract: 'CONTRACT.md 1',
    file: 'src/run/run-migration.ts',
    from: '          lineageOut.add({\n            address,\n            contributionKind: \'RECORD\',',
    to: '          if (disposition === \'MERGED_PROVEN\') continue;\n          lineageOut.add({\n            address,\n            contributionKind: \'RECORD\',',
  },
  {
    id: 'M08',
    title: 'a merge conflict is resolved by taking the first value',
    contract: 'CONTRACT.md 7',
    file: 'src/identity/resolve-identity.ts',
    from: "    const resolveBySurvivor = policies.mergeFieldConflict === 'PREFER_SURVIVOR' && semanticsClass !== 'CONSENT';",
    to: "    const resolveBySurvivor = policies.mergeFieldConflict.length > 0 && semanticsClass.length > 0;",
  },
  {
    id: 'M09',
    title: 'an unresolved relationship is dropped instead of reported',
    contract: 'CONTRACT.md 9',
    file: 'src/associations/build-edges.ts',
    from:
      '    const unresolved = describeUnresolved(candidate);\n    if (unresolved !== null) {\n      edgesOut.add(\n        entry(candidate, sourceEdgeId, \'UNRESOLVED\', unresolved.reasonCode, unresolved.detail, null, null, null),\n      );\n      written += 1;\n      continue;\n    }',
    to: '    if (describeUnresolved(candidate) !== null) continue;',
  },
  {
    id: 'M10',
    title: 'an artifact is altered after it was hashed',
    contract: 'CONTRACT.md 13',
    file: 'src/artifacts/write-package.ts',
    // Artifacts are streamed now, so the mutation appends a byte after the file
    // has been written and hashed. Reading the delivered bytes back is what has
    // to notice, which is the guarantee this mutation exists to test.
    from: '  // The manifest states what was written, not what was predicted.',
    to: "  if (file.path === '03_TRACEABILITY/source-lineage.csv') writeFileSync(target, Buffer.from('\\n'), { flag: 'a' });\n  // The manifest states what was written, not what was predicted.",
  },
  {
    id: 'M11',
    title: 'the verifier stops comparing artifact hashes against the bytes on disk',
    contract: 'CONTRACT.md 13',
    file: 'src/verify/verify-package.ts',
    // Re-anchored. The check used to read a whole artifact with readFileSync and
    // hash the Buffer; it now hashes the same bytes in blocks through
    // `digestFile`, which is how the verifier stopped holding an artifact in
    // order to check it. What it compares did not change, so neither does the
    // mutation: make the measurement agree with the manifest by construction, so
    // the bytes on disk are never actually consulted.
    from: '    if (measured.sha256 !== artifact.sha256) {',
    to: '    if (measured.sha256 !== measured.sha256) {',
  },
  {
    id: 'M12',
    title: 'the audit summary counts rows for itself instead of reading the reconciliation',
    contract: 'CONTRACT.md 12',
    file: 'src/artifacts/audit.ts',
    from: '      `All ${count(rows.ingested, \'source row\')} read from the input files have exactly one disposition. ${String(rows.withoutDisposition)} rows disappeared.`,',
    to: '      `All ${count(rows.byDisposition.OUTPUT, \'source row\')} read from the input files have exactly one disposition. 0 rows disappeared.`,',
  },
  {
    id: 'M13',
    title: 'an identifier is coerced through a number, losing its leading zeros',
    contract: 'CONTRACT.md 5',
    file: 'src/transform/transformations.ts',
    from: "  return outcome('UNCHANGED', input, 'TRANSFORM_IDENTIFIER_PRESERVED');",
    to: "  const coerced = Number.isFinite(Number(input)) ? String(Number(input)) : input;\n  return settle(input, coerced, 'TRANSFORM_IDENTIFIER_PRESERVED', []);",
  },
  {
    id: 'M14',
    title: 'a number with no country evidence is assumed to be American',
    contract: 'CONTRACT.md 5',
    file: 'src/transform/transformations.ts',
    from: '  if (!explicitInternational && options.countryEvidence === null) {',
    to: "  if (!explicitInternational && options.countryEvidence === null && options.countryEvidenceSource === 'never-matches') {",
    extra: {
      from: '  const parsed = explicitInternational\n    ? parsePhoneNumberFromString(input)\n    : parsePhoneNumberFromString(input, options.countryEvidence as CountryCode);',
      to: "  const parsed = explicitInternational\n    ? parsePhoneNumberFromString(input)\n    : parsePhoneNumberFromString(input, (options.countryEvidence ?? 'US') as CountryCode);",
    },
  },
  {
    id: 'M15',
    title: 'an ambiguous date is read as month-day-year',
    contract: 'CONTRACT.md 5',
    file: 'src/transform/transformations.ts',
    from: '  const pattern = PATTERNED_FORMATS[context.declaredFormat];',
    to: "  const pattern = PATTERNED_FORMATS[context.declaredFormat ?? 'MM/DD/YYYY'];",
    extra: {
      from: '  if (context.declaredFormat === null || context.declaredFormat === \'ISO_8601\') {',
      to: '  if (context.declaredFormat === \'ISO_8601\' || (context.declaredFormat === null && iso !== null)) {',
    },
  },
  {
    id: 'M16',
    title: 'repeated headers are collapsed into the first matching column',
    contract: 'CONTRACT.md 1 and DECISIONS.md',
    file: 'src/mapping/resolve-columns.ts',
    from: '  const found = matches[occurrence - 1];',
    to: '  const found = matches[0];',
  },
  {
    id: 'M17',
    title: 'a cached formula result is delivered with no provenance and no authorization',
    contract: 'CONTRACT.md 6',
    file: 'src/transform/apply.ts',
    from: "    if (input.policies.formulaCachedValues === 'ISOLATE_ROW') {\n      return build('UNSUPPORTED', raw, 'TRANSFORM_FORMULA_CACHED_VALUE_NOT_AUTHORIZED'",
    to: "    if (false as boolean) {\n      return build('UNSUPPORTED', raw, 'TRANSFORM_FORMULA_CACHED_VALUE_NOT_AUTHORIZED'",
  },
  {
    id: 'M18',
    title: 'values in unmapped columns are discarded',
    contract: 'CONTRACT.md 10',
    file: 'src/run/build-records.ts',
    from: '      if (consumed.has(cell.columnIndex)) continue;',
    to: '      if (!consumed.has(cell.columnIndex)) continue;',
  },
  {
    id: 'M19',
    title: 'a workbook with no workbook part is accepted as empty',
    contract: 'CONTRACT.md 16',
    file: 'src/ingest/xlsx-reader.ts',
    from: '  const workbookXml = read(\'xl/workbook.xml\');\n  if (workbookXml === null) {',
    // The replacement has to satisfy `WorkbookHandle`, which is what this
    // function returns since the reader started streaming. It used to return a
    // `Workbook` shape — `hasFormulas` and no `rows` — so the mutation did not
    // compile, and a mutation that does not compile is scored DID_NOT_COMPILE
    // rather than KILLED: the suite is never asked the question.
    to: '  const workbookXml = read(\'xl/workbook.xml\');\n  if (workbookXml === null) {\n    return { sheets: [], dateSystem: \'DATE_1900\', hasExternalLinks: false, rows: () => [][Symbol.iterator]() };\n  }\n  if (false as boolean) {',
  },
  {
    id: 'M20',
    title: 'a destination required-field check is removed',
    contract: 'CONTRACT.md 11',
    file: 'src/run/validate-destination.ts',
    from: '      for (const required of spec.requiredForCreate) {',
    to: '      for (const required of [] as typeof spec.requiredForCreate) {',
  },
  {
    id: 'M21',
    title: 'the row equation compares the lineage against itself',
    contract: 'CONTRACT.md 1',
    file: 'src/reconcile/reconcile.ts',
    from: '      ingested: ingestedRows,',
    to: '      ingested: totalRows,',
  },
  {
    id: 'M22',
    title: 'an external identifier is concatenated into the id segment again',
    contract: 'CONTRACT.md 7',
    file: 'src/domain/identity.ts',
    from: `    key.keyKind,
    key.keyColumn,
    key.keyColumnAddress,
    key.sourceRecordId,`,
    to: `    'SOURCE_RECORD_ID',
    '',
    '',
    key.keyKind === 'EXTERNAL_ID' ? \`ext:\${key.keyColumn}:\${key.sourceRecordId}\` : key.sourceRecordId,`,
  },
  {
    id: 'M23',
    title: 'the identity space is dropped, so independent id sequences collide',
    contract: 'CONTRACT.md 7',
    file: 'src/domain/identity.ts',
    from: '    key.identitySpace,',
    to: "    '',",
  },
  {
    id: 'M24',
    title: 'a value the boolean rule could not read is rewritten anyway',
    contract: 'CONTRACT.md 4',
    file: 'src/run/build-records.ts',
    from: "        result.reasonCode === 'TRANSFORM_BOOLEAN_PARSED'",
    to: "        result.reasonCode !== 'TRANSFORM_NUMBER_INVALID'",
  },
  {
    id: 'M26',
    title: 'the last data row of a CSV never reaches the sheet',
    contract: 'CONTRACT.md 1',
    file: 'src/ingest/ingest-bundle.ts',
    from: '      pass.end();\n      yield* held;',
    to: '      pass.end();',
  },
  {
    id: 'M27',
    title: 'the last data row of a worksheet never reaches the sheet',
    contract: 'CONTRACT.md 1',
    // Re-anchored: there is no `workbookSheet.rows` array any more. The reader
    // hands rows out one at a time, so a sheet's rows are never all in memory
    // and `.slice(1, -1)` has nothing to slice.
    //
    // The guarantee has not moved, so neither has the mutation's intent: every
    // data row of a worksheet reaches the sheet. Dropping the last one is now
    // done the way a streaming reader would drop it by accident — hold a row
    // back, hand out the previous one, and never flush the last.
    files: [
      {
        file: 'src/ingest/ingest-bundle.ts',
        from: '        let seenHeader = false;\n        for (const workbookRow of workbook.rows(workbookSheet.index)) {',
        to: '        let seenHeader = false;\n        let held: SourceRow | null = null;\n        for (const workbookRow of workbook.rows(workbookSheet.index)) {',
      },
      {
        file: 'src/ingest/ingest-bundle.ts',
        from: '          if (outcome.kind === \'ACCEPTED\') yield outcome.row;',
        to: '          if (outcome.kind === \'ACCEPTED\') {\n            if (held !== null) yield held;\n            held = outcome.row;\n          }',
      },
    ],
  },
  {
    id: 'M28',
    title: 'the row count is taken from the arrays the lineage walks, restoring the identity',
    contract: 'CONTRACT.md 1',
    files: [
      {
        file: 'src/ingest/ingest-bundle.ts',
        from: '    readerRowCount,',
        to: '    readerRowCount: dataRowCount + rejectedRows.length,',
      },
      {
        file: 'src/ingest/ingest-bundle.ts',
        from: '      pass.end();\n      yield* held;',
        to: '      pass.end();',
      },
    ],
  },
  {
    id: 'M29',
    title: 'the key column loses its address, so two columns with one header merge again',
    contract: 'CONTRACT.md 7',
    file: 'src/domain/identity.ts',
    from: '    key.keyColumnAddress,',
    to: "    '',",
  },
  {
    id: 'M30',
    title: 'the configuration is allowed to declare a consent field ordinary',
    contract: 'CONTRACT.md 9',
    file: 'src/domain/canonical.ts',
    from: "  return fieldSemanticsClass(name) === 'CONSENT' || declared === 'CONSENT' ? 'CONSENT' : 'STANDARD';",
    to: '  return declared ?? fieldSemanticsClass(name);',
  },
  {
    id: 'M31',
    title: 'the independent row count is disabled, so a reader defect is invisible again',
    contract: 'CONTRACT.md 1',
    file: 'src/ingest/row-census.ts',
    from: '  if (produced === census) return;',
    to: '  if (produced === census || produced >= 0) return;',
  },
  {
    id: 'M32',
    title: 'a row element outside sheetData is silently discarded again',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/xlsx-reader.ts',
    from: "        if (tag === 'row' || tag === 'c') {",
    to: "        if (tag === 'rowOutsideSheetDataIsFine') {",
  },
  {
    id: 'M33',
    title: 'two sheet declarations may read one worksheet part, doubling its rows',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/xlsx-reader.ts',
    from: '      const owner = partOwners.get(part);',
    to: '      const owner = undefined;',
  },
  {
    id: 'M34',
    title: 'rows out of position order are accepted, so the header can be the wrong row',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/xlsx-reader.ts',
    from: '        if (rowNumber < highestRowNumber) {',
    to: '        if (rowNumber < 0) {',
  },
  {
    id: 'M35',
    title: 'a formatted empty leading row is taken as the header row again',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/ingest-bundle.ts',
    // Re-anchored for the same reason as M27: the sheet's rows are no longer an
    // array, so `workbookSheet.rows.length > 1` is gone. Streaming, the same
    // question — is there a data row after this one — is answered by
    // `hasDataRows` when the second row arrives, which is one row earlier than
    // the materialising reader could answer it.
    from: "      if (headerRow.cells.every((cell) => (cell.raw ?? '').trim().length === 0) && hasDataRows) {",
    // `hasDataRows` stays in the condition: without it the variable is unused
    // and `noUnusedLocals` rejects the mutation before the suite sees it.
    to: '      if (hasDataRows && headerRow.cells.length === -1) {',
  },
  {
    id: 'M36',
    title: 'a document with more than one top-level element is accepted',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/xml-pull-parser.ts',
    from: '  if (rootsSeen > 1) {',
    to: '  if (rootsSeen > 1000000) {',
  },
  {
    id: 'M37',
    title: 'a relationship may point anywhere, as long as both ends exist',
    contract: 'CONTRACT.md 9',
    file: 'src/verify/verify-package.ts',
    from: '    const side = ownerSideByMapping.get(mappingId);',
    to: "    const side = undefined as 'FROM' | 'TO' | undefined;",
  },
  {
    id: 'M38',
    title: 'the verification notes are accepted whatever they say',
    contract: 'CONTRACT.md 14',
    file: 'src/verify/verify-package.ts',
    from: '  if (declaredNotes.join(ORDER_SEPARATOR) !== packagedNotes.join(ORDER_SEPARATOR)) {',
    to: '  if (declaredNotes.length < 0 && packagedNotes.length < 0) {',
  },
  {
    id: 'M39',
    title: 'a second archive member with the same name may shadow the first',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/xlsx-reader.ts',
    // Re-anchored: the archive's directory is now walked here rather than by
    // fflate, because the reader had to stop taking its directory from one end
    // of the container and its data from the other. The check itself is
    // unchanged in what it refuses.
    from: '    if (entries.has(name)) {',
    to: '    if (entries.has(name) && name.length < 0) {',
  },
  {
    id: 'M40',
    title: 'a delivered value holding a line break is rejected as a CRLF file',
    contract: 'CONTRACT.md 15',
    // Re-anchored a second time, and the check has moved further each time: it
    // compared whole decoded text, then a line at a time, and now it never holds
    // the file at all — the bytes are hashed in blocks and a rendering of each
    // record is hashed beside them.
    //
    // The guarantee is the one that has not moved. A delivered value may hold a
    // line break, because a multi-line address typed on Windows is a real thing
    // to find in a spreadsheet, and an artifact must not be rejected for
    // carrying one properly quoted. The mutation therefore does what the naive
    // reading did: scan the raw blocks for CRLF and condemn the file.
    files: [
      {
        file: 'src/verify/verify-package.ts',
        from: '    let records = 0;\n    let bom = false;',
        to: '    let records = 0;\n    let bom = false;\n    let sawCrlf = false;',
      },
      {
        file: 'src/verify/verify-package.ts',
        from: '        fileDigest.update(buffer.subarray(0, read));\n        fileBytes += read;',
        to:
          '        if (buffer.subarray(0, read).includes(Buffer.from([13, 10]))) sawCrlf = true;\n' +
          '        fileDigest.update(buffer.subarray(0, read));\n        fileBytes += read;',
      },
      {
        file: 'src/verify/verify-package.ts',
        from:
          "    const canonical =\n      records > 0 && renderedBytes === fileBytes && renderedDigest.digest('hex') === fileDigest.digest('hex');",
        to:
          "    const canonical =\n      !sawCrlf && records > 0 && renderedBytes === fileBytes && renderedDigest.digest('hex') === fileDigest.digest('hex');",
      },
    ],
  },
  {
    id: 'M41',
    title: 'artifact order is re-derived from the row locator text again',
    contract: 'CONTRACT.md 12',
    file: 'src/verify/verify-package.ts',
    from: "  ['changes.csv', [['file_path', 'text'], ['sheet_id', 'text'], ['row_number', 'number']]],",
    to: "  ['changes.csv', [['row_locator_id', 'text']]],",
  },
  {
    id: 'M42',
    title: 'a flag on an absorbed row is compared against the survivor value',
    contract: 'CONTRACT.md 7',
    file: 'src/verify/verify-package.ts',
    from: '      if (absorbedRows.has(rowId)) return;',
    to: '      if (absorbedRows.has(rowId) && rowId.length < 0) return;',
  },
  {
    id: 'M43',
    title: 'a relationship far end is resolved by raw id without its record mapping',
    contract: 'CONTRACT.md 9',
    file: 'src/verify/verify-package.ts',
    from: '    const mapKey = `${target.recordMappingId}${PAIR_SEPARATOR}${target.object}${PAIR_SEPARATOR}${rawKey}`;',
    to: '    const mapKey = `${target.object}${PAIR_SEPARATOR}${rawKey}`;',
  },
  {
    id: 'M44',
    title: 'a migration key is accepted without following from its own identity',
    contract: 'CONTRACT.md 8',
    file: 'src/verify/verify-package.ts',
    from: '    if (migrationKey !== expectedKey) {',
    to: '    if (migrationKey !== expectedKey && migrationKey.length < 0) {',
  },
  {
    id: 'M45',
    title: 'a merge id is accepted without following from the keys it cites',
    contract: 'CONTRACT.md 7',
    file: 'src/verify/verify-package.ts',
    from: '    if (merge.mergeId !== expected) {',
    to: '    if (merge.mergeId !== expected && merge.mergeId.length < 0) {',
  },
  {
    id: 'M46',
    title: 'leftover rows are no longer corroborated at all',
    contract: 'CONTRACT.md 1',
    file: 'src/verify/verify-package.ts',
    // Re-anchored: the check became one streamed pass, so the way to stop
    // corroborating every leftover is to leave the walk before it looks at
    // anything. Leftovers are rows that reached no destination; a package that
    // does not corroborate them can call a lost row a leftover and be believed.
    from: "    if (reason === 'LEFTOVER_NO_RECORD_MAPPING') {",
    to: "    if (rowId.length + reason.length >= 0) return; if (reason === 'LEFTOVER_NO_RECORD_MAPPING') {",
  },
  {
    id: 'M47',
    title: 'a merge that absorbs nothing buys the change-log exemption again',
    contract: 'CONTRACT.md 4',
    file: 'src/verify/verify-package.ts',
    from: '      .filter((merge) => merge.absorbedRowLocatorIds.length > 0)',
    to: '      .filter((merge) => merge.absorbedRowLocatorIds.length >= 0)',
  },
  {
    id: 'M48',
    title: 'isolated rows are no longer corroborated at all',
    contract: 'CONTRACT.md 1',
    file: 'src/verify/verify-package.ts',
    // Re-anchored. The isolated list used to be read into a table and walked;
    // it is now streamed a row at a time beside a lineage cursor, because the
    // check keeps nothing from a row and never needed them all at once. What it
    // corroborates is unchanged, so the mutation is unchanged: walk nothing.
    from: "  for (const row of readCsvFileRows(artifactPath(packageDir, 'isolated.csv'), {\n    ...CSV_LIMITS,\n    filePath: 'isolated.csv',\n  })) {",
    to: "  for (const row of ([] as unknown as ReturnType<typeof readCsvFileRows>)) {",
  },
  {
    id: 'M49',
    title: 'the conflict checks go back inside the loop an empty file disables',
    contract: 'CONTRACT.md 11',
    file: 'src/verify/verify-package.ts',
    from: '  if (conflictIsolatedKeys.size > 0) {',
    to: '  if (conflictIsolatedKeys.size > 0 && [...conflicted.values()].some((state) => state.named)) {',
  },
  {
    id: 'M50',
    title: 'edge-file relationships are skipped by the endpoint check again',
    contract: 'CONTRACT.md 9',
    file: 'src/verify/verify-package.ts',
    from: '    const edgeFile = edgeFileEnds.get(mappingId);',
    to: '    const edgeFile = undefined as { from: string; to: string } | undefined;',
  },
  {
    id: 'M51',
    title: 'an association isolation reason is accepted without the ledger saying so',
    contract: 'CONTRACT.md 1',
    file: 'src/verify/verify-package.ts',
    // Re-anchored twice. The per-row rescan became one pass building a keyed
    // set, and the keyed set became a spilled disagreement between two scans —
    // the isolations claiming a relationship reason on one side, and the ledger
    // entries that would corroborate them on the other.
    //
    // So the way to accept a reason nobody stated is no longer to ignore a set;
    // it is to put nothing on the side that has to be answered. An isolation
    // that is never asked about is an isolation nothing can contradict.
    // The whole callback, because removing only the `add` call leaves the
    // parameter unread and `noUnusedParameters` rejects the build — a mutation
    // that does not compile is not a test of anything. Renaming it to `_add` is
    // the language's own way of saying "deliberately unused", so the edit still
    // says exactly one thing: this side contributes nothing to be answered.
    from:
      "    (add) => {\n      scanTable(packageDir, 'isolated.csv', () => (row) => {\n" +
      "        const reason = row['reason_code'] ?? '';\n" +
      "        if (!reason.startsWith('ASSOCIATION_')) return;\n" +
      "        add(`${row['row_locator_id'] ?? ''}${PAIR_SEPARATOR}${reason}`);\n      });\n    },",
    to:
      "    (_add) => {\n      scanTable(packageDir, 'isolated.csv', () => (row) => {\n" +
      "        const reason = row['reason_code'] ?? '';\n" +
      "        if (!reason.startsWith('ASSOCIATION_')) return;\n      });\n    },",
  },
  {
    id: 'M52',
    title: 'a record named in a conflict may vanish from the package',
    contract: 'CONTRACT.md 11',
    file: 'src/verify/verify-package.ts',
    from: '    if (!state.delivered && !state.isolated) {',
    to: '    if (!state.delivered && !state.isolated && key.length < 0) {',
  },
  {
    id: 'M54',
    title: 'source-backed verification stops comparing the bytes it derives',
    contract: 'CONTRACT.md 13',
    file: 'src/verify/verify-against-source.ts',
    // Re-anchored. The comparison used to read both copies of an artifact whole
    // and call `.equals` on two Buffers; it is now `sameBytes`, which reads them
    // a block at a time — the change that let a 64,819,304-byte lineage be
    // compared without holding two of it. What it decides is unchanged, so the
    // cut is unchanged: make the difference unreachable.
    from: "    if (!sameBytes(join(authoritativeDir, ...path.split('/')), join(candidateDir, ...path.split('/')))) {",
    to: "    if (!sameBytes(join(authoritativeDir, ...path.split('/')), join(candidateDir, ...path.split('/'))) && path.length < 0) {",
  },
  {
    id: 'M55',
    title: 'source-backed verification stops noticing an invented source row',
    contract: 'CONTRACT.md 1',
    file: 'src/verify/verify-against-source.ts',
    // Re-anchored. The check asked a Map whether it held the locator; it is now
    // a merge of two ordered families, so the shape of 'the package has a row the
    // source does not' is one side of a co-group holding rows while the other is
    // empty. Same invariant, same cut: make that branch unreachable.
    from: '    if (held.length > 0 && source.length === 0) {\n      counts.sourceRowsInvented += held.length;',
    to: '    if (held.length > 0 && source.length === 0 && id.length < 0) {\n      counts.sourceRowsInvented += held.length;',
  },
  {
    id: 'M56',
    title: 'the canonical digest stops covering the path a file sits at',
    contract: 'CONTRACT.md 13',
    file: 'src/artifacts/package-digest.ts',
    from: '    return `${path} ${sha256Hex(bytes)}`;',
    to: '    return `${sha256Hex(bytes)}`;',
  },
  {
    id: 'M53',
    title: 'relationship endpoints are matched case-insensitively again',
    contract: 'CONTRACT.md 9',
    file: 'src/associations/build-edges.ts',
    from: '      k: orderText(key),\n      v: { keyRaw: key, migrationKey: record.migrationKey',
    to: '      k: orderText(key.toLowerCase()),\n      v: { keyRaw: key, migrationKey: record.migrationKey',
  },
  {
    id: 'M57',
    title: 'a placeholder in an authoritative id column is discarded silently again',
    contract: 'CONTRACT.md 7',
    file: 'src/run/build-records.ts',
    from: '      if (isSentinelIdentifier(value)) {',
    to: '      if (isSentinelIdentifier(value) && value.length < 0) {',
  },
  {
    id: 'M58',
    title: 'a merge erases the evidence of an id collision again',
    contract: 'CONTRACT.md 7',
    file: 'src/identity/resolve-identity.ts',
    from: '      if (seen.has(key)) continue;',
    to: '      if (seen.has(key) || member !== record.survivor) continue;',
  },
  {
    id: 'M59',
    title: 'two fields may write their extension into one destination again',
    contract: 'CONTRACT.md 12',
    file: 'src/mapping/load-config.ts',
    from: '      if (otherExtension !== undefined) {',
    to: '      if (otherExtension !== undefined && extension.length < 0) {',
  },
  {
    id: 'M60',
    // The refusal this used to mutate is gone: UPDATE_ONLY and UPSERT are no
    // longer refused outright, they are refused when nothing declares what the
    // destination matches on. The mutation follows the rule to where it moved.
    title: 'a matching import mode is accepted without saying what it matches on',
    contract: 'CONTRACT.md 11a',
    file: 'src/mapping/load-config.ts',
    from: "      if (match === undefined || match.matchAuthority === 'NONE') {",
    to: "      if (match === undefined) {",
  },
  {
    id: 'M67',
    title: 'a column Kauro made up is accepted as destination match authority',
    contract: 'CONTRACT.md 11a',
    file: 'src/target/match-authority.ts',
    // The comparison folds separators as well as case now, because a real
    // portal showed that `kauro_trace_key` walked past a case-only fold. The
    // guarantee under attack is the same one: a trace key is never a match key.
    from: '  if (targetField !== null && associationKeyHeaders.some((header) => sameInternalKeyName(header, targetField))) {',
    to: '  if (targetField !== null && associationKeyHeaders.some((header) => sameInternalKeyName(header, String()))) {',
  },
  {
    id: 'M68',
    title: 'an External ID that is not unique is accepted for upsert',
    contract: 'CONTRACT.md 11a',
    file: 'src/target/match-authority.ts',
    from: '    if (!isDefinitely(field.unique)) {',
    to: '    if (!isDefinitely(field.externalId)) {',
  },
  {
    id: 'M69',
    title: 'an attribute nobody established is read as established',
    contract: 'CONTRACT.md 11a',
    file: 'src/target/contract.ts',
    from: "  return flag === 'TRUE';",
    to: "  return flag !== 'FALSE';",
  },
  {
    id: 'M61',
    title: 'a relationship can vanish between being built and being counted',
    contract: 'CONTRACT.md 9',
    // Re-anchored. The loop this used to cut was in run-migration.ts, copying
    // `associations.edges` into an `edges` family that buildEdges had already
    // written under the same key with the same encoder — a second segment of
    // the same family, read by nothing. Removing that copy removed the anchor
    // with it, and the mutation reported ERROR rather than a verdict.
    //
    // The invariant did not move: a relationship must not vanish between being
    // built and being counted. So the cut moved to where the edges are now
    // given their dispositions, which is the only place one can still be lost.
    // The candidate count is taken before any disposition is assigned, so the
    // loss shows as a disagreement between two independently derived numbers,
    // which is exactly what this mutation exists to prove somebody checks.
    file: 'src/associations/build-edges.ts',
    from: '  for (const held of heldById) {\n    const candidate = held.candidate;',
    to: '  let droppedOne = false;\n  for (const held of heldById) {\n    if (!droppedOne) { droppedOne = true; continue; }\n    const candidate = held.candidate;',
  },
  {
    id: 'M62',
    title: 'a relationship is lost and the count is re-derived from the array that lost it',
    contract: 'CONTRACT.md 9',
    files: [
      {
        file: 'src/reconcile/reconcile.ts',
        from: '      sourceEdges: truth.edgeCandidateCount,',
        to: '      sourceEdges: truth.edges.count,',
      },
      {
        file: 'src/reconcile/reconcile.ts',
        from: '      withoutDisposition: truth.edgeCandidateCount - edgesAccountedFor,',
        to: '      withoutDisposition: truth.edges.count - edgesAccountedFor,',
      },
      {
        // A relationship is dropped on its way into the family, which is where
        // one could now be lost. Paired with the two edits above, the tally is
        // then re-derived from the family that lost it — the identity that
        // makes the loss invisible, which is the whole point of counting the
        // candidates where they are produced instead.
        //
        // Re-anchored with M61 when the redundant copy in run-migration.ts was
        // removed. The tally is still incremented here even though the edge is
        // not written, and that asymmetry is deliberate: buildEdges holds its
        // own identity, `written === candidates.count`, and a cut that tripped
        // it would be killed by that guard long before the reconciliation ever
        // saw the loss. M61 is the mutation that guard is for. This one has to
        // get past it, so that what is left to catch the loss is the
        // reconciliation — which the two edits above have just taught to ask
        // the family that lost it.
        file: 'src/associations/build-edges.ts',
        from: '  for (const held of heldById) {\n    const candidate = held.candidate;',
        to: '  let lostOne = false;\n  for (const held of heldById) {\n    if (!lostOne) { lostOne = true; written += 1; continue; }\n    const candidate = held.candidate;',
      },
    ],
  },
  {
    id: 'M63',
    title: 'a record is withheld by naming a field the destination does not require',
    contract: 'CONTRACT.md 12',
    file: 'src/verify/verify-package.ts',
    from: "      if (!requiredFieldsByMapping.get(mappingId)?.has(named)) {",
    to: "      if (!requiredFieldsByMapping.get(mappingId)?.has(named) && named.length < 0) {",
  },
  {
    id: 'M64',
    title: 'the candidate may supply the configuration it is judged against',
    contract: 'CONTRACT.md 13a',
    file: 'src/verify/verify-against-source.ts',
    from: '  if (configPath === packageDir || configPath.startsWith(packageDir + sep)) {',
    to: '  if (configPath === packageDir) {',
  },
  {
    id: 'M65',
    title: 'the authority hashes stop covering the bytes the run read',
    contract: 'CONTRACT.md 13a',
    file: 'src/verify/verify-against-source.ts',
    from: '    if (hashed === null || read === undefined || hashed !== read) {',
    to: '    if (hashed === null && read === undefined) {',
  },
  {
    id: 'M66',
    title: 'source-backed verification stops comparing derived identifiers',
    contract: 'CONTRACT.md 13a',
    file: 'src/verify/verify-against-source.ts',
    // Re-anchored. The column list moved out of the loop into DERIVED_COLUMNS,
    // which the lineage projection also reads, so the loop now walks the constant
    // by index. Comparing only the first of them is the same mutation: six
    // derived identifiers stop being compared and nothing says so.
    from: '    DERIVED_COLUMNS.forEach((column, index) => {',
    to: '    DERIVED_COLUMNS.slice(0, 1).forEach((column, index) => {',
  },
  {
    id: 'M71',
    title: 'a row shorter than its header re-renders as itself and passes',
    contract: 'CONTRACT.md 15',
    file: 'src/verify/verify-package.ts',
    // The canonical-bytes check compares each line against a re-render of the
    // record parsed from it. Re-render the raw fields and the comparison becomes
    // circular: any line reproduces itself, so a row missing a field — or a file
    // repeating a header with two different values in it — reads as canonical.
    // Addressing fields by header name is what stops that.
    //
    // This replaced a mutation on the tail check, which survived because it
    // cannot be observed: the reader turns every byte into a record, so the
    // offset always reaches the end of the file whenever every line matched.
    // A mutation nothing can see is not evidence that nothing is checking.
    from: '      const line = headers.map((name) => escapeField(named[name] ?? \'\')).join(\',\');',
    to: '      const line = fields.map((value) => escapeField(value)).join(\',\');',
  },
  {
    id: 'M70',
    title: 'a property the portal will not write is offered as writable',
    contract: 'CONTRACT.md 11a',
    file: 'src/target/hubspot-artifacts.ts',
    // A real portal reached this repository through this line. The artifact says
    // whether a property's value is read-only; reading it backwards would offer
    // a match on a property the portal refuses to write, which fails at the one
    // moment nobody is watching — during somebody's migration.
    //
    // Re-anchored when the properties-API reader arrived. `writableFlag(cell)`
    // read the export's column and became `writableFrom(readOnlyValue,
    // calculated)`, shared by both readers so the export and the API cannot
    // derive writability differently about the same portal. The line moved and
    // the parameter is named for the fact rather than the column; what it
    // decides is unchanged, and it now decides it for two artifact kinds
    // instead of one, which makes this mutation worth more than it was.
    from: "  if (readOnlyValue === 'TRUE') return 'FALSE';",
    to: "  if (readOnlyValue === 'TRUE') return 'TRUE';",
  },
  {
    id: 'M25',
    title: 'a truncated worksheet reads as a shorter well-formed one',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/xml-pull-parser.ts',
    from: '  if (openElements.length > 0) {',
    to: '  if (openElements.length > 1000000) {',
  },
  {
    id: 'M72',
    title: 'an authorized clear is demoted to an omission on its way out of the run',
    contract: 'CONTRACT.md 5',
    file: 'src/run/run-migration.ts',
    // The defect the value-intent work closed, put back exactly as it was. The
    // delivered map dropped every field with nothing in it, and a clear has
    // nothing in it, so the plan's instruction to empty a field left the run as
    // silence. Nothing downstream could tell the difference, which is why it
    // survived a green suite.
    from: "      clearedFields: fields\n        .filter(([, resolved]) => resolved.intent.kind === 'CLEAR')\n        .map(([name]) => name),",
    to: '      clearedFields: [],',
  },
  {
    id: 'M73',
    title: 'a clear the destination cannot express is shipped as a blank anyway',
    contract: 'CONTRACT.md 5',
    file: 'src/run/validate-destination.ts',
    // HubSpot ignores a blank cell for a property that already holds a value.
    // Dropping the refusal produces a file that imports cleanly, reports no
    // error, and leaves the value the plan authorized removing exactly where it
    // was — while the package says it was cleared.
    from: "    const clearMayApply = mode !== 'CREATE_ONLY';",
    to: '    const clearMayApply = false;',
  },
  {
    id: 'M74',
    title: 'a delivered value that reads as the clear instruction is delivered anyway',
    contract: 'CONTRACT.md 5',
    file: 'src/run/validate-destination.ts',
    // Where Kauro owns the format, one exact string means "empty this field".
    // Letting a source value equal to it through writes an instruction nobody
    // gave, and a reader has no way to tell it from one that was given.
    from: "        if (intendedValue(resolved.intent) === token) {",
    to: "        if (intendedValue(resolved.intent) === `${token}${token}`) {",
  },
  {
    id: 'M75',
    title: 'the external sort loses the tie-break that makes its order total',
    contract: 'CONTRACT.md 14',
    file: 'src/scratch/external-sort.ts',
    // Without the input position, records with equal keys are ordered by
    // whatever the merge happened to do with them — which depends on where the
    // run boundaries fell, which depends on how much memory the machine had. The
    // output stays sorted and stops being reproducible, and sorted-looking
    // output is exactly what makes that hard to notice.
    from: '  return `${key}${KEY_TERMINATOR}${padded}`;',
    to: '  return `${key}${KEY_TERMINATOR}${padded.slice(0, 0)}`;',
  },
  {
    id: 'M76',
    title: 'a spilled segment is read back without being checked against its manifest',
    contract: 'CONTRACT.md 13',
    file: 'src/scratch/filesystem-scratch-store.ts',
    // The entire basis for trusting a spill is that the run can prove what it
    // gets back is what it put in, without keeping what it put in. Drop the
    // proof and scratch becomes a place where rows can change without anybody
    // finding out.
    from: '        if (digest !== segment.manifest.sha256 || seen !== segment.manifest.byteLength) {',
    to: '        if (digest !== segment.manifest.sha256 && seen !== seen) {',
  },
  {
    id: 'M77',
    title: 'the scratch quota stops being a limit',
    contract: 'CONTRACT.md 16',
    file: 'src/scratch/filesystem-scratch-store.ts',
    from: '    if (bytes > options.quotaBytes) {',
    to: '    if (bytes > options.quotaBytes * 1_000_000_000) {',
  },
  {
    id: 'M78',
    title: 'a segment declared sorted is trusted rather than checked',
    contract: 'CONTRACT.md 14',
    file: 'src/scratch/filesystem-scratch-store.ts',
    // A merge that believes an unsorted segment is sorted produces plausible
    // output in the wrong order, and nothing downstream re-checks it.
    from: '          if (lastKey !== null && compareCodeUnits(key, lastKey) < 0) {',
    to: '          if (lastKey !== null && compareCodeUnits(key, lastKey) < -1000) {',
  },
  {
    id: 'M79',
    title: 'a signature that does not verify is accepted anyway',
    contract: 'CONTRACT.md 11a',
    file: 'src/target/attestation.ts',
    // The whole point of an attestation is that somebody outside the run made
    // the claim. Stop checking the signature and any well-formed JSON becomes an
    // authority, including one the run could have written itself.
    from: "    if (!verified && reasons.every((reason) => !reason.startsWith('the signature could not be checked'))) {",
    to: "    if (verified && reasons.every((reason) => !reason.startsWith('the signature could not be checked'))) {",
  },
  {
    id: 'M80',
    title: 'a run stops consulting the attestation it requires',
    contract: 'CONTRACT.md 11a',
    file: 'src/run/run-migration.ts',
    // A seam nothing calls is a library, not a control. This leaves the module
    // correct and simply never asks it, which is how such a check dies quietly.
    //
    // Re-anchored, twice, and the second attempt is the instructive one.
    //
    // The line this used to cut read the policy off `input` and defaulted it to
    // NOT_REQUIRED — the permissive default MC-2 removed, so the line no longer
    // exists and the mutation reported ERROR rather than a verdict.
    //
    // The obvious replacement was an early return inside the check itself, on
    // `policy === 'REQUIRED'`. It does not compile, and why is worth recording:
    // with that return in place TypeScript narrows `policy` to the two
    // remaining values, and the comparison the real code makes a few lines
    // later has no overlap left. The types are tight enough that the check
    // cannot be switched off from the inside without saying so out loud.
    //
    // So the cut moved to the call site, which is where such a check actually
    // dies in practice: the seam stays correct, the guard stays compiled, and
    // the run simply stops asking for the modes that need it.
    from: '  assertTargetInstanceAttested(input, targetContract);',
    to: "  if (input.config.target.mode === 'CLEAN_ONLY') assertTargetInstanceAttested(input, targetContract);",
  },
  {
    id: 'M81',
    title: 'an expired attestation is treated as current',
    contract: 'CONTRACT.md 11a',
    file: 'src/target/attestation.ts',
    // A capture describes an instance as it was. Reusing one indefinitely means
    // matching against a schema the destination may no longer have.
    from: '    } else if (isIsoInstant(attestation.expiresAt) && attestation.expiresAt <= expect.at) {',
    to: "    } else if (isIsoInstant(attestation.expiresAt) && attestation.expiresAt <= '') {",
  },
  {
    id: 'M82',
    title: 'the package is built where it will be read, so it is live before it is checked',
    contract: 'CONTRACT.md 13',
    file: 'src/artifacts/write-package.ts',
    // Staging is the only reason there is no moment at which a reader can see
    // half a package. Point it at the destination and the package is published
    // by the act of writing it — before verification, before attestation, and
    // whatever happens part way through.
    from: '  return `${resolve(outputDir)}.kauro-staging`;',
    to: '  return resolve(outputDir);',
  },
  {
    id: 'M83',
    title: 'a package that was not published is left on disk anyway',
    contract: 'CONTRACT.md 13',
    file: 'src/artifacts/write-package.ts',
    // Staging holds customer data. A run that fails, or a package that does not
    // verify, has to leave nothing behind — otherwise every failed run adds a
    // copy of somebody's CRM to the workspace, and nothing later knows it is
    // there to delete.
    //
    // Not mutated: the `||` in the read-back comparison. Turning it into `&&`
    // is unobservable, because a digest that matches over bytes of a different
    // length is a hash collision. A mutation nothing can see is not evidence
    // that nothing is checking.
    from: "export function discardStagedPackage(staged: Pick<WritePackageResult, 'stagingDir'>): void {\n  rmSync(resolve(staged.stagingDir), { recursive: true, force: true });",
    to: "export function discardStagedPackage(staged: Pick<WritePackageResult, 'stagingDir'>): void {\n  if (staged.stagingDir === '') rmSync(resolve(staged.stagingDir), { recursive: true, force: true });",
  },
  {
    id: 'M84',
    title: 'a run accepts a profile that describes different bytes',
    contract: 'CONTRACT.md 5b',
    file: 'src/profile/source-profile.ts',
    // The profile exists so that the plan compiled from it and the execution
    // that follows are about the same bytes. Stop comparing and the binding is
    // a field somebody filled in: a plan compiled against a dataset that has
    // since changed would be carried out against the new one, and no artifact
    // anywhere would say so.
    from: '  if (supplied.profile.bundleId !== bundleId) {',
    to: '  if (supplied.profileHash.length >= 0) return;\n  if (supplied.profile.bundleId !== bundleId) {',
  },
  {
    id: 'M85',
    title: 'the profile samples its distinct counts instead of counting them',
    contract: 'CONTRACT.md 5b',
    file: 'src/profile/source-profile.ts',
    // Full dataset means full dataset. An approximate distinct count is the one
    // thing the canonical contract names and forbids, because a plan decides
    // whether a column can be a key from this number.
    // Re-anchored when the family gained a `release()` and the sealed handle
    // became a named binding. The behaviour this breaks is unchanged: the walk
    // that produces the exact distinct counts stops after a hundred cells.
    from: '  for (const cell of sealed) {',
    to: '  let seen = 0;\n  for (const cell of sealed) {\n    seen += 1;\n    if (seen > 100) break;',
  },
  {
    id: 'M86',
    title: '01_IMPORT carries the Kauro trace key again',
    contract: 'CONTRACT.md 11b',
    file: 'src/artifacts/render-package.ts',
    // The whole point of the four areas. A trace key in an import file is a
    // column the operator may map, which puts Kauro internal identity into a
    // customer CRM and lets a later export carry it back out.
    // Re-anchored: the cells of one record moved into `ImportTable.cells`, which
    // the renderer, the partition plan and the crosswalk all derive from, so
    // there is one place a trace key could be smuggled into 01_IMPORT rather
    // than three.
    // Two edits, because one does not compile. Taking the trace key out of the
    // row leaves `truth` unused in `importTables`, and `noUnusedLocals` rejects
    // that before the suite is ever asked the question — which scores
    // DID_NOT_COMPILE, not KILLED. The destructure goes with it.
    files: [
      {
        file: 'src/artifacts/render-package.ts',
        from: '        return keyed ? [importKeyFor(truth.runId, record.migrationKey), ...values] : values;',
        to: '        return keyed ? [record.migrationKey, ...values] : values;',
      },
      {
        file: 'src/artifacts/render-package.ts',
        from: 'function importTables(input: RenderInput): ImportTable[] {\n  const { truth, adapter, config } = input;',
        to: 'function importTables(input: RenderInput): ImportTable[] {\n  const { adapter, config } = input;',
      },
    ],
  },
  {
    id: 'M87',
    title: 'the association key follows from the trace key alone',
    contract: 'CONTRACT.md 11b',
    file: 'src/artifacts/import-key.ts',
    // A key derived from the migration key alone is the same in every run over
    // the same source, so a value left behind in a CRM correlates one
    // migration with another and with whatever else holds that key.
    from: "    .update(runId, 'utf8')",
    to: "    .update(runId.slice(0, 0), 'utf8')",
  },
  {
    id: 'M88',
    title: 'an artifact is written to the package root',
    contract: 'CONTRACT.md 11b',
    file: 'src/artifacts/layout.ts',
    // The directory is the safeguard. An artifact at the root is a file the
    // operator cannot classify, sitting beside the one directory they were
    // told to import.
    from: "  return `${area}/${name}`;",
    to: "  return name === 'changes.csv' ? name : `${area}/${name}`;",
  },
  {
    id: 'M89',
    title: 'the crosswalk numbers its rows without regard to position',
    contract: 'CONTRACT.md 11b',
    file: 'src/artifacts/render-package.ts',
    // The crosswalk is the only witness that a given line of a given import
    // file is the record the evidence talks about. Numbers that are not
    // positions point import rows at the wrong records while the package
    // stays internally consistent by every other measure.
    from: '        String(rowNumber),',
    to: '        String(rowNumber === 1 ? 1 : rowNumber + 1),',
  },
  {
    id: 'M90',
    title: 'the reader carries every piece instead of reading it',
    contract: 'CONTRACT.md 15a',
    file: 'src/ingest/csv-reader.ts',
    // The defect this reader shipped with for a while: it parsed nothing until
    // the last piece arrived, so the carry grew to hold the whole file and the
    // parse became quadratic in its size. The records it produced were
    // identical, which is why every agreement test passed, and why the
    // incrementality tests had to state it as behaviour instead.
    from: '  for (; index < limit; index += 1) {',
    to: '  for (; index < (final ? limit : 0); index += 1) {',
  },
  {
    id: 'M91',
    title: 'a leftover is corroborated against no source row at all',
    contract: 'CONTRACT.md 12',
    file: 'src/verify/verify-package.ts',
    // A leftover row says the configuration covered nothing on it. The lineage
    // is the witness, and reading nothing from it means every leftover is
    // corroborated by default -- which is how a delivered record is withheld
    // by relabelling it.
    from: "    const recordMapping = leftoverLineage.at(row)?.recordMappingId ?? '';",
    to: "    const recordMapping = leftoverLineage === null ? '' : '';",
  },

  {
    id: 'M92',
    title: 'a dropped part of a cut import file passes as a complete import',
    contract: 'CONTRACT.md 11b',
    file: 'src/artifacts/import-partition.ts',
    // An import file too large for the destination is delivered as numbered
    // parts. Remove part two of five and each of the four remaining files
    // verifies perfectly on its own -- the records that were in part two are
    // simply gone, and nothing but the continuity of the numbering says so.
    // This is the check that makes cutting a file safe rather than a new way to
    // lose rows.
    from: '    if (!parts.includes(path) && NUMBERED_PART.test(path)) {',
    // `NUMBERED_PART` stays referenced so the mutation compiles; what it loses
    // is the ability to fire.
    to: '    if (!parts.includes(path) && NUMBERED_PART.test(path) && path.length < 0) {',
  },

  {
    id: 'M93',
    title: 'a part of a cut import file holds one row more than the destination accepts',
    contract: 'CONTRACT.md 11b',
    file: 'src/artifacts/import-partition.ts',
    // The cut has to fall before the row that would take the part past the
    // limit, not after it. One row late and every part but the last is
    // over-size, so the package the engine just cut to fit cannot be delivered
    // either -- and the operator is handed files the vendor rejects at upload.
    from: '    if (inThisPart > 0 && bytes + rowBytes > maxFileBytes) {',
    to: '    if (inThisPart > 0 && bytes > maxFileBytes) {',
  },

  // ---------------------------------------------------------------- MC-3
  //
  // The contracts Intelligence Core builds against, and the command line an
  // operator drives. Each of these is a repair MC-3 made, written as the defect
  // it repaired: undo the fix and the mutation is exactly what the code was.

  {
    id: 'M94',
    title: 'a source profile is accepted on its version alone, without its schema',
    contract: 'CONTRACT.md 5b',
    file: 'src/profile/source-profile.ts',
    // What `loadSourceProfile` did before MC-3: check `profileVersion` and
    // return. `{"profileVersion":"1.0.0"}` loaded as a profile of nothing, and
    // a run could then be bound to a description of no dataset at all.
    from: '  const violations = validateAgainstSchema(parsed, SERIALIZED_PROFILE_SCHEMA);',
    to: '  const violations = validateAgainstSchema(parsed, SERIALIZED_PROFILE_SCHEMA).slice(0, 0);',
  },

  {
    id: 'M95',
    title: 'a source profile whose counters contradict each other is accepted',
    contract: 'CONTRACT.md 5b',
    file: 'src/profile/source-profile.ts',
    // The invariants are what make a profile a description rather than a shape.
    // Without them a column can report more distinct values than populated
    // cells, and a plan can be compiled from a key candidate that is not one.
    from: '  const problems = profileInvariantProblems(document.profile);',
    to: '  const problems = profileInvariantProblems(document.profile).slice(0, 0);',
  },

  {
    id: 'M96',
    title: 'a profile built under a different reading of the bundle is accepted by a run',
    contract: 'CONTRACT.md 5b',
    file: 'src/profile/source-profile.ts',
    // Encodings, delimiters, sheet selections, limits and the row policies
    // decide what the reader produces, so two readings of one file are two
    // datasets. A plan compiled against one may not be executed against the
    // other, and before MC-3 nothing said so.
    from: "  if (config !== undefined) {\n    const expected = canonicalJsonText",
    to: "  if (config !== undefined && config === null) {\n    const expected = canonicalJsonText",
  },

  {
    id: 'M97',
    title: 'a candidate set built for another revision is accepted',
    contract: 'KAURO_INTELLIGENCE_CORE_CANONICO_V1 section 6',
    file: 'src/profile/candidate-set.ts',
    // A set built by another core is about candidates another core would
    // produce. Accepting one lets a proposal chosen among someone else's
    // candidates be applied here, which is the seam's whole subject.
    from: '  if (mismatches.length > 0) {\n    refuse(where, `was built for another revision',
    to: '  if (mismatches.length > 0 && mismatches.length < 0) {\n    refuse(where, `was built for another revision',
  },

  {
    id: 'M98',
    title: 'the command line accepts an option it does not know',
    contract: 'CONTRACT.md 17',
    file: 'src/cli/main.ts',
    // A misspelt `--source-profile` used to run the migration without a
    // profile, silently. An operator who typed it believed the run was bound to
    // one and the package says nothing about a profile it never saw.
    from: "    if (!spec.flags.includes(name)) {\n      problems.push(`unknown option --${name}`);",
    to: "    if (!spec.flags.includes(name)) {\n      if (name !== name) problems.push(`unknown option --${name}`);",
  },

  {
    id: 'M99',
    title: 'a destination type token nobody implemented is read as a text field',
    contract: 'CONTRACT.md 11d',
    file: 'src/run/validate-destination.ts',
    // R-MC-TYPE: a `time` or a token no vendor documents took any TEXT value
    // and the package verified. The destination's type is what is unknown.
    from: '  if (family !== undefined) return family;',
    to: "  if (family !== undefined) return family;\n  if (field.type !== '') return 'TEXT';",
  },
  {
    id: 'M100',
    title: 'an empty or unestablished vocabulary is read as an open one',
    contract: 'CONTRACT.md 11d',
    file: 'src/run/validate-destination.ts',
    // R-MC-ENUM: a restricted enumeration with no option, or one whose
    // restriction nobody captured, took every value the source allowed.
    from: "  if (field.restrictedPicklist === 'FALSE') return { kind: 'OPEN' };",
    to: "  if (field.restrictedPicklist !== field.type) return { kind: 'OPEN' };",
  },
  {
    id: 'M101',
    title: "an option's display label admits the value",
    contract: 'CONTRACT.md 11d',
    file: 'src/run/validate-destination.ts',
    // The label is not what the instance stores; delivering it writes a
    // different string from the option the source meant.
    from: '  if (vocabulary.active.some((option) => option.value === value)) return null;',
    to: '  if (vocabulary.active.some((option) => option.value === value || option.label === value)) return null;',
  },
  {
    id: 'M102',
    title: 'a calendar date is written into an instant field wherever one is found',
    contract: 'CONTRACT.md 11d',
    file: 'src/run/validate-destination.ts',
    // Qualified for HubSpot by vendor evidence and for nothing else; elsewhere
    // it would need a time and a zone this engine does not have.
    from: "  return semanticType === 'DATE' && family === 'DATETIME' && DATE_INTO_DATETIME_QUALIFIED.has(mode);",
    to: "  return semanticType === 'DATE' && family === 'DATETIME' && (DATE_INTO_DATETIME_QUALIFIED.has(mode) || mode.length > 0);",
  },
  {
    id: 'M103',
    title: 'the verifier ignores the trusted target contract it is handed',
    contract: 'CONTRACT.md 13c',
    file: 'src/verify/verify-package.ts',
    // The structural verifier alone passed packages carrying values the
    // instance does not take; a host that supplies the contract must get the
    // answer to the question it asked.
    from: '  if (options.targetContract !== undefined || options.requireTargetContract === true) {',
    to: '  if (false as boolean) {',
  },
  {
    id: 'M104',
    title: 'the verifier takes a supplied contract body on its word',
    contract: 'CONTRACT.md 13c',
    file: 'src/verify/target-evidence.ts',
    // A permissive body under the strict digest would then pass what the
    // strict instance refuses.
    from: "    trusted = loadTargetContract(serializeTargetContract(supplied), 'the supplied target contract');",
    to: "    trusted = supplied.contract === null ? loadTargetContract(serializeTargetContract(supplied), 'the supplied target contract') : supplied;",
  },
  {
    id: 'M105',
    title: 'the verifier accepts a contract the package was not shaped against',
    contract: 'CONTRACT.md 13c',
    file: 'src/verify/target-evidence.ts',
    from: '  if (input.recordedContractHash !== trusted.contractHash) {',
    to: "  if (input.recordedContractHash === null && trusted.contractHash === '') {",
  },
  {
    id: 'M106',
    title: 'the verifier re-decides the plan and never reads an emitted cell',
    contract: 'CONTRACT.md 13c',
    file: 'src/verify/target-evidence.ts',
    // A label delivered into a known vocabulary passes every plan-level fact;
    // only the cell gives it away.
    from: '    const finding = instanceFinding({ values }, entry.plan, creates);',
    to: '    const finding = values.size < 0 ? instanceFinding({ values }, entry.plan, creates) : null;',
  },
  {
    id: 'M107',
    title: 'a CRM package verified without a required contract passes on structure',
    contract: 'CONTRACT.md 13c',
    file: 'src/verify/target-evidence.ts',
    from: "    if (input.required && mode !== 'CLEAN_ONLY') {",
    to: "    if (input.required && mode === 'CLEAN_ONLY') {",
  },
  {
    id: 'M108',
    title: "a HubSpot deal's pipeline and stage are read from the property alone",
    contract: 'CONTRACT.md 11d',
    file: 'src/run/validate-destination.ts',
    // R-MC-PIPELINE: HubSpot keeps both vocabularies in its pipelines; read
    // from the property each is unknown, and every deal plan was refused.
    from: '  return pipelines.length === 0 ? null : { role, pipelines };',
    to: '  return pipelines.length === 0 ? null : null;',
  },
  {
    id: 'M109',
    title: 'a deal stage is admitted under a pipeline that does not contain it',
    contract: 'CONTRACT.md 11d',
    file: 'src/run/validate-destination.ts',
    // Each value is eligible on its own; the portal refuses the pair.
    from: '  if (owner.stages.some((entry) => entry.stageInternalName === stageValue)) return null;',
    to: '  if (owner.stages.length >= 0) return null;',
  },
  // M110-M114 belong to the value and identity exactness mandate (B01-R1, B01-R2).
  {
    id: 'M110',
    title: 'every field trims again unless it says otherwise',
    contract: 'CONTRACT.md 5a (trim), decision D67',
    file: 'src/domain/config.ts',
    // The default that rewrote padded text with no approval anywhere.
    from: 'export const DEFAULT_FIELD_OPTIONS: FieldOptions = {\n  trim: false,',
    to: 'export const DEFAULT_FIELD_OPTIONS: FieldOptions = {\n  trim: true,',
  },
  {
    id: 'M111',
    title: 'an identifier is trimmed on its way into the identity key',
    contract: 'CONTRACT.md 7 (identity keys are exact), decision D67',
    file: 'src/run/build-records.ts',
    // "A" and " A " became one key, and one record, with no declared decision.
    from: '  const normalized = normalizeIdentityValue(value, normalization);',
    to: '  const normalized = normalizeIdentityValue(value.trim(), normalization);',
  },
  {
    id: 'M112',
    title: 'a local time that never happened is shifted an hour forward',
    contract: 'CONTRACT.md 5 (Timestamps), decision D68',
    file: 'src/transform/transformations.ts',
    // The missing hour becomes a real time, delivered as though the source said it.
    from: '  const resolution = resolveLocalTime(localSeconds, timezone.zone);',
    to: "  let resolution = resolveLocalTime(localSeconds, timezone.zone);\n  if (resolution.kind === 'GAP') resolution = resolveLocalTime(localSeconds + 3600, timezone.zone);",
  },
  {
    id: 'M113',
    title: 'a declared zone is accepted against any tzdata release',
    contract: 'CONTRACT.md 5 (Timestamps), decision D68',
    file: 'src/transform/timezone.ts',
    // The rules behind a zone name change between releases; the plan named one.
    from: '  if (runtime === null || policy.tzdata !== runtime) {',
    to: "  if (runtime === null && policy.tzdata === '\\u0000') {",
  },
  // M115-M119 belong to the occurrence identity and input envelope mandate (B01-R3, B01-R5, B02-R1, B02-R2).
  {
    id: 'M115',
    title: 'equal bytes in two namespaces stop the run again, on the digest alone',
    contract: 'CONTRACT.md 7 (occurrence identity), decision D69',
    file: 'src/ingest/ingest-bundle.ts',
    // Without this line a namespace holding one file is treated like one holding
    // two, and a byte-identical export from a second instance is refused.
    from: '      if (members.length < 2) continue;\n      const decided',
    to: '      const decided',
  },
  {
    id: 'M116',
    title: 'archive member names are compared as written, not as part names',
    contract: 'CONTRACT.md 15a (part identity), decision D70',
    file: 'src/ingest/xlsx-reader.ts',
    // No canonical-name refusal and no case-fold or percent-decode: an alias of a
    // worksheet is a second, unrelated part.
    from: '    const why = nonCanonicalReason(name);\n    if (why !== null) {',
    to: '    const why: string | null = null;\n    if (why !== null) {',
    extra: {
      from: '    const { identity, decodedProblem } = partIdentity(name);',
      // `partIdentity` stays referenced so that the mutated tree still compiles.
      to: "    const identity = name;\n    const decodedProblem: string | null = partIdentity(name).identity === '\\u0000' ? 'x' : null;",
    },
  },
  {
    id: 'M117',
    title: 'a worksheet is bounded only by the workbook total',
    contract: 'CONTRACT.md 16 (the conjunctive envelope), decision D70',
    file: 'src/ingest/xlsx-reader.ts',
    from: '    if (originalSize > limits.maxWorkbookPartUncompressedBytes) {',
    to: '    if (originalSize < 0) {',
  },
  {
    id: 'M118',
    title: 'a cell is measured only when it ends',
    contract: 'CONTRACT.md 16 (record envelope), decision D71',
    file: 'src/ingest/csv-reader.ts',
    from: '    if (fieldSoFar > options.maxCellLength) throw cellTooLong(fieldSoFar, true);',
    to: '    if (fieldSoFar < 0) throw cellTooLong(fieldSoFar, true);',
  },
  {
    id: 'M119',
    title: 'a record has no size limit',
    contract: 'CONTRACT.md 16 (record envelope), decision D71',
    file: 'src/ingest/csv-reader.ts',
    from: '    if (recordSoFar > maxRecordBytes) throw recordTooLong(recordSoFar, true);',
    to: '    if (recordSoFar < 0) throw recordTooLong(recordSoFar, true);',
    extra: {
      from: '      if (bytes > maxRecordBytes) throw recordTooLong(bytes, false);',
      to: '      if (bytes < 0) throw recordTooLong(bytes, false);',
    },
  },
  // M120-M124 belong to the formula cache, human view and release/evidence checks mandate (B01-R4, B01-R6, B02-R4, S092).
  {
    id: 'M120',
    title: 'a formula the workbook never calculated is accepted as an empty cell again',
    contract: 'CONTRACT.md 6 (an absent cache is UNSUPPORTED), decision D72',
    file: 'src/transform/apply.ts',
    // An ABSENT cache always has raw null, so requiring a non-null raw makes the
    // guard unreachable and the row falls through to the empty-value branch.
    from: "    if (cell.cachedValue === 'ABSENT' || raw === null) {",
    to: "    if (cell.cachedValue === 'ABSENT' && raw !== null) {",
  },
  {
    id: 'M121',
    title: 'the human view is written exactly like the machine file',
    contract: 'CONTRACT.md 11b (human view), decision D72',
    file: 'src/artifacts/human-view.ts',
    from: '  return startsLikeFormula(value) ? `${NEUTRALISING_PREFIX}${value}` : value;',
    to: '  return value;',
  },
  {
    id: 'M122',
    title: 'the verifier does not look at the cells of a human view',
    contract: 'CONTRACT.md 11b (the verifier refuses an executable cell in a human view), decision D72',
    file: 'src/verify/verify-package.ts',
    from: '    assertNoExecutableCell(packageDir, artifact.path, fail);',
    to: '    void assertNoExecutableCell;',
  },
  {
    id: 'M123',
    title: 'the published asset is checked by its version text, not by its bytes',
    contract: 'DECISIONS.md D73 (a published asset is checked by its bytes and its installation)',
    files: [
      {
        file: 'tools/published-asset-check.mjs',
        from: "record('asset.sha256EqualsDossierSum', dossierSum !== null && dossierSum === assetSha256,",
        to: "record('asset.sha256EqualsDossierSum', dossierSum !== null,",
      },
      {
        file: 'tools/published-asset-check.mjs',
        from: "typeof reconstruction.packageSha256 === 'string' && reconstruction.packageSha256 === assetSha256, 'sha256(asset) equals the tarball",
        to: "typeof reconstruction.packageSha256 === 'string', 'sha256(asset) equals the tarball",
      },
      {
        file: 'tools/published-asset-check.mjs',
        from: "record('asset.entriesEqualReconstruction', differences.length === 0,",
        to: "record('asset.entriesEqualReconstruction', differences.filter((text) => text.includes('package/package.json')).length === 0,",
      },
    ],
  },
  {
    id: 'M124',
    title: 'evidence recorded under a fingerprint that has moved is reused without an equivalence record',
    contract: 'DECISIONS.md D73 (evidence is reused through an explicit equivalence, S092)',
    file: 'tools/producer-closure.mjs',
    from: '  if (recorded.fingerprint === current.fingerprint) return [];',
    to: '  if (recorded.fingerprint !== null) return [];',
  },
  // M125-M129 belong to the merge lineage, absorbed-id endpoint and skewed join mandate (B01-R7, B01-R8, B02-R3, S031, S032, R2-016).
  {
    id: 'M125',
    title: 'the whole cluster membership is written again under every member row',
    contract: 'CONTRACT.md 16a (a cluster membership is written once), decision D74',
    file: 'src/run/records-by-row.ts',
    from: `    if (members.length > 1) {
      membershipWriter.add({ address: orderAddressOf(survivorSource), members });
    }`,
    to: `    if (members.length > 1) {
      for (const source of record.members) membershipWriter.add({ address: orderAddressOf(source), members });
    }
    void survivorSource;`,
  },
  {
    id: 'M126',
    title: 'every row of a merged record is indexed under the first member id only',
    contract: 'CONTRACT.md 9 (an absorbed id resolves to the survivor), decision D74',
    file: 'src/associations/build-edges.ts',
    from: "(_row, record) => record.member.sourceRecordId ?? '');",
    to: "(_row, record) => record.survivor.sourceRecordId ?? '');",
  },
  {
    id: 'M127',
    title: 'the join collects a whole bucket into arrays again, whatever bound it was given',
    contract: 'CONTRACT.md 16a (a hot bucket is bounded), decision D74',
    file: 'src/verify/join.ts',
    from: '  const bound = options.bound ?? Number.POSITIVE_INFINITY;',
    to: '  const bound = Number.POSITIVE_INFINITY;',
  },
  {
    id: 'M128',
    title: 'the distinct targets of a key are found by searching every one already kept',
    contract: 'CONTRACT.md 16a (distinct targets in one pass over sorted input), decision D74',
    files: [
      {
        file: 'src/associations/build-edges.ts',
        from: '  let previous: { readonly k: string; readonly migrationKey: string } | null = null;',
        to: '  const kept: Keyed<TargetRef>[] = [];\n  let previous: { readonly k: string; readonly migrationKey: string } | null = null;',
      },
      {
        file: 'src/associations/build-edges.ts',
        from: '    if (previous !== null && previous.k === entry.k && previous.migrationKey === migrationKey) continue;',
        to: '    if (previous !== null && kept.some((held) => held.k === entry.k && held.v.migrationKey === migrationKey)) continue;\n    kept.push(entry);',
      },
    ],
  },
  {
    id: 'M129',
    title: 'a record that answers to a key through two of its rows counts as two targets',
    contract: 'CONTRACT.md 9 (a record is one target however many of its rows name the key), decision D74',
    file: 'src/associations/build-edges.ts',
    from: '  for (const entry of distinctTargets(entries)) {\n    if (current !== null && current.k === entry.k) {',
    to: '  for (const entry of entries) {\n    if (current !== null && current.k === entry.k) {',
  },
  // M130-M135 belong to 3.1.0 (N1-1, D78), written by O18A: the code Order 13 changed had no mutation of its own.
  {
    id: 'M130',
    title: 'the person signals read a Contact only, so leads sharing an email, phone or name are never reported',
    contract: 'CONTRACT.md 7 (supporting evidence for any person record), decision D78',
    file: 'src/identity/resolve-identity.ts',
    from: 'return nonEmpty(carried(values.get(`contact.${field}`) ?? values.get(`lead.${field}`)));',
    to: 'return nonEmpty(carried(values.get(`contact.${field}`)));',
  },
  {
    id: 'M131',
    title: 'a duplicate bucket forgets the object, so a Lead and a Contact sharing an email form one cluster',
    contract: 'CONTRACT.md 7 (a cluster never spans two objects), decision D78',
    file: 'src/identity/resolve-identity.ts',
    from: 'shared.add({ bucket: `${record.object}|${value}`, subject });',
    to: 'shared.add({ bucket: `PERSON|${value}`, subject });',
  },
  {
    id: 'M132',
    title: 'an unsupported relationship file is described as a pairing beside the supported ones',
    contract: 'CONTRACT.md 9 (an unsupported relationship is named as such), decision D78',
    file: 'src/artifacts/import-instructions.ts',
    from: "      if (support.kind === 'UNSUPPORTED') {",
    to: "      if (support.kind === 'UNSUPPORTED' && type === '') {",
  },
  {
    id: 'M133',
    title: 'a supported relationship line counts the leftovers of its type instead of what it delivers',
    contract: 'CONTRACT.md 9 (each supported line carries its own count), decision D78',
    file: 'src/artifacts/import-instructions.ts',
    from: "          ` ${String(count(type, 'OUTPUT'))} relationships.`,",
    to: "          ` ${String(count(type, 'LEFTOVER'))} relationships.`,",
  },
  {
    id: 'M134',
    title: 'the HubSpot strategy no longer warns that the association key is not a common column',
    contract: 'CONTRACT.md 9 (HubSpot common column is a unique identifier), decision D78',
    file: 'src/artifacts/import-instructions.ts',
    from: "        ' both object files carry a column under that header with different values, so do not select it as a' +",
    to: "        ' both object files carry a column under that header with different values, so select it as a' +",
  },
  {
    id: 'M135',
    title: 'the Salesforce strategy no longer says where an Account Id comes from',
    contract: 'CONTRACT.md 9 (an AccountId is proved by the success file), decision D78',
    file: 'src/artifacts/import-instructions.ts',
    from: "        ' the success file starts with an `ID` column holding each new Account Id, repeats every column of the' +",
    to: "        ' the success file holds each new Account, repeats every column of the' +",
  },
];

function edits(mutation) {
  if (mutation.files !== undefined) return mutation.files;
  const list = [{ file: mutation.file, from: mutation.from, to: mutation.to }];
  if (mutation.extra !== undefined) list.push({ file: mutation.file, ...mutation.extra });
  return list;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', shell: false, ...options });
}

function build() {
  return run(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);
}

/**
 * How long one mutated suite may take before the harness stops waiting.
 *
 * Generous — the unmutated suite runs in about twenty seconds — because a
 * mutation that makes the engine slow is a real finding and should be reported
 * as a timeout rather than cut off at the first sign of being slower than
 * usual. What this bounds is a mutation that makes the suite hang, which
 * without it stops the whole run rather than one mutation.
 */
const SUITE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * `--suite-filter <part>` runs only the test files whose path holds `<part>` under each mutation (O18A). A mutation the
 * named files kill is killed by the whole suite too, so a KILLED verdict stands; a SURVIVED one does not, and such a run is
 * always PARTIAL. It exists for the mutations of one change, re-proved against the files that own them on a shared machine
 * where the full corpus does not fit the time.
 */
const suiteFilterIndex = process.argv.indexOf('--suite-filter');
const suiteFilter = suiteFilterIndex === -1 ? null : (process.argv[suiteFilterIndex + 1] ?? null);

function suite() {
  const filter = suiteFilter === null ? [] : ['--filter', suiteFilter];
  return run(process.execPath, [join(repoRoot, 'tools', 'run-tests.mjs'), ...filter], { timeout: SUITE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * What happened to the suite under one mutation, classified.
 *
 * `killed = tested.status !== 0` was the whole of this, and it counts every
 * non-zero exit as a kill: a suite that could not be spawned, one that ran out
 * of disk, one that hung until something stopped it, one whose harness threw
 * before the first test. Each of those exits non-zero without a single
 * assertion having failed, and each was scored as "the suite noticed" — which
 * is exactly the reading that makes a mutation corpus decorative, because the
 * mutations most likely to break the harness are the ones the suite is least
 * likely to actually catch.
 *
 * A kill is now one thing: the suite ran, and it reported failing tests. The
 * runner prints `SUMMARY files=… tests=… pass=… fail=…`, so the number of
 * failures is read from the run rather than inferred from its exit code.
 *
 * @returns {{outcome: string, detail: string}}
 */
function classifySuite(result) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const summary = /SUMMARY files=(\d+) tests=(\d+) pass=(\d+) fail=(\d+) skipped=(\d+)/u.exec(output);
  if (result.error !== undefined && result.error.code === 'ETIMEDOUT') {
    return { outcome: 'TIMEOUT', detail: `the suite did not finish within ${String(SUITE_TIMEOUT_MS)} ms` };
  }
  if (result.error !== undefined) {
    return { outcome: 'INFRA_ERROR', detail: `the suite could not be run: ${String(result.error.message)}` };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return { outcome: 'INFRA_ERROR', detail: `the suite was terminated by ${String(result.signal)}` };
  }
  if (summary === null) {
    // No summary line means the runner did not reach the end of its own work.
    // That is a broken harness or a broken environment, and calling it a kill
    // would credit the suite with noticing something it never ran.
    return {
      outcome: 'INFRA_ERROR',
      detail: `the suite printed no summary, so nothing says whether a test failed (exit ${String(result.status)}): ${output.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`,
    };
  }
  const failed = Number(summary[4]);
  const ran = Number(summary[2]);
  if (ran === 0) {
    return { outcome: 'INFRA_ERROR', detail: 'the suite ran no tests at all, so it noticed nothing' };
  }
  if (failed > 0) {
    return { outcome: 'KILLED', detail: `${String(failed)} of ${String(ran)} tests failed` };
  }
  if (result.status !== 0) {
    return {
      outcome: 'INFRA_ERROR',
      detail: `the suite exited ${String(result.status)} with every one of its ${String(ran)} tests passing, so the non-zero exit is not an assertion`,
    };
  }
  return { outcome: 'SURVIVED', detail: `${String(ran)} tests, none failed` };
}

// `--only M46,M51` runs a named subset. It exists so a re-anchored mutation
// can be re-proved in a minute instead of an hour. The gate and CI always run
// the whole list, and a partial run says so in both the header and the
// summary, so no report can pass one off as the full harness.
const onlyFlag = process.argv.indexOf('--only');
const only =
  onlyFlag === -1
    ? null
    : new Set(String(process.argv[onlyFlag + 1] ?? '').split(',').map((id) => id.trim()));
if (only !== null) {
  const missing = [...only].filter((id) => !MUTATIONS.some((mutation) => mutation.id === id));
  if (missing.length > 0) throw new Error('--only names no such mutation: ' + missing.join(', '));
}
const selected = only === null ? MUTATIONS : MUTATIONS.filter((mutation) => only.has(mutation.id));
const scope =
  only === null
    ? String(MUTATIONS.length)
    : 'PARTIAL RUN, ' + String(selected.length) + ' of ' + String(MUTATIONS.length);

/**
 * Every anchor, checked before the first mutation is applied.
 *
 * One run cost thirty-five minutes to discover that three anchors no longer
 * existed. M61, M62 and M80 all pointed into `src/run/run-migration.ts`, which
 * MC-2 rewrote: two named a copy loop removed as redundant, the third named the
 * permissive attestation default that removing was the whole point. Nothing was
 * wrong with the mutations — their anchors had been overtaken — and the harness
 * found out one at a time, after eighty-eight builds and eighty-eight suites.
 *
 * Reading every anchor first costs milliseconds and answers the same question.
 * A missing or duplicated anchor is not a mutation that failed; it is a
 * mutation that was never asked, and the difference matters because the first
 * is a defect in the engine and the second is a defect in this file.
 */
function preflight(mutations, root) {
  const problems = [];
  const seen = new Set();
  for (const mutation of mutations) {
    if (seen.has(mutation.id)) problems.push(`${mutation.id} is declared more than once`);
    seen.add(mutation.id);
    for (const target of edits(mutation)) {
      const path = join(root, ...target.file.split('/'));
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        problems.push(`${mutation.id}: ${target.file} does not exist`);
        continue;
      }
      const occurrences = text.split(target.from).length - 1;
      if (occurrences !== 1) {
        problems.push(`${mutation.id}: anchor appears ${String(occurrences)} times in ${target.file}`);
      }
    }
  }
  return problems;
}

// `--preflight` answers only the anchor question and exits. It exists because
// the answer is worth having in seconds after any change under `src/`, and
// because asking for it should never risk starting a thirty-five minute run.
const preflightOnly = process.argv.includes('--preflight');

// Read from the source, before any copy is made. The anchors are a question
// about the tree you are in, and answering it should not cost a copy of that
// tree: the first version copied first and took two minutes to say something it
// could have said in a tenth of a second, which is how a fast check becomes one
// nobody runs.
const anchorProblems = preflight(selected, sourceRoot);
if (anchorProblems.length > 0) {
  process.stderr.write(`sabotage preflight failed on ${String(anchorProblems.length)} anchors:\n`);
  for (const problem of anchorProblems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write(
    '\nAn anchor that is not in the source is a mutation nobody asked, not a defect the suite missed.\n' +
      'Re-anchor it to the behaviour it was written to break. Do not delete it and do not widen it.\n',
  );
  process.exit(1);
}

if (preflightOnly) {
  process.stdout.write(
    `sabotage preflight: ${String(selected.length)} anchors, every one present exactly once\n`,
  );
  process.exit(0);
}

prepareWorkTree();

const results = [];
let survivors = 0;

process.stdout.write(`sabotage: ${scope} mutations, ${String(selected.length)} anchors verified\n\n`);

for (const mutation of selected) {
  const targets = edits(mutation);
  const originals = new Map();

  try {
    for (const target of targets) {
      const path = join(repoRoot, ...target.file.split('/'));
      const text = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, text);
      const occurrences = text.split(target.from).length - 1;
      if (occurrences !== 1) {
        throw new Error(`anchor appears ${String(occurrences)} times in ${target.file}`);
      }
      writeFileSync(path, text.replace(target.from, target.to));
    }

    const compiled = build();
    if (compiled.status !== 0) {
      results.push({ id: mutation.id, outcome: 'DID_NOT_COMPILE', detail: (compiled.stdout ?? '').split('\n')[0] ?? '' });
      process.stdout.write(`  ${mutation.id} DID NOT COMPILE — ${mutation.title}\n`);
      continue;
    }

    const classified = classifySuite(suite());
    if (classified.outcome === 'SURVIVED') survivors += 1;
    results.push({ id: mutation.id, outcome: classified.outcome, detail: classified.detail, title: mutation.title });
    process.stdout.write(
      `  ${mutation.id} ${classified.outcome === 'KILLED' ? 'killed  ' : classified.outcome.padEnd(8)} — ${mutation.title} (${classified.detail})\n`,
    );
  } catch (error) {
    results.push({ id: mutation.id, outcome: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
    process.stdout.write(`  ${mutation.id} ERROR    — ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
}

// Leave the tree exactly as it was found, compiled from unmutated source.
const restored = build();
if (restored.status !== 0) {
  process.stderr.write('failed to rebuild after restoring the source\n');
  process.stderr.write(restored.stdout ?? '');
  process.exit(1);
}

const killed = results.filter((entry) => entry.outcome === 'KILLED').length;
const broken = results.filter((entry) => entry.outcome !== 'KILLED' && entry.outcome !== 'SURVIVED');
// The classes, counted. A summary that reported only "killed" and "survived"
// hid the difference between a suite that caught a mutation and a suite that
// could not be run against it, and the second was scored as the first.
const byOutcome = {};
for (const entry of results) byOutcome[entry.outcome] = (byOutcome[entry.outcome] ?? 0) + 1;

process.stdout.write(
  `\n${String(killed)}/${String(selected.length)} mutations killed, ${String(survivors)} survived\n` +
    `outcomes: ${Object.entries(byOutcome)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([outcome, count]) => `${outcome} ${String(count)}`)
      .join(', ')}\n`,
);

if (broken.length > 0) {
  process.stderr.write('\nmutations that were not evaluated by an assertion:\n');
  for (const entry of broken) process.stderr.write(`  ${entry.id}: ${entry.outcome} — ${entry.detail ?? ''}\n`);
  process.stderr.write(
    '\nNone of these is a kill. A mutation the suite could not be run against is a mutation nobody asked, and counting one as\n' +
      'caught is how a corpus comes to report a coverage it does not have.\n',
  );
}

/**
 * The result, written where a provenance record can read it.
 *
 * `tools/provenance.mjs` counted the declared mutations out of this file's
 * source and paired the number with `state: 'PASS'` — a literal. So the release
 * record asserted that every mutation was killed, with a count it had derived
 * and a verdict it had not, and would have gone on asserting it after a run in
 * which twenty survived.
 */
const evidenceIndex = process.argv.indexOf('--evidence');
if (evidenceIndex !== -1 && process.argv[evidenceIndex + 1] !== undefined) {
  writeFileSync(
    process.argv[evidenceIndex + 1],
    `${JSON.stringify(
      {
        gate: 'SABOTAGE',
        observedAt: `${new Date().toISOString().slice(0, 19)}Z`,
        scope: only === null && suiteFilter === null ? 'FULL' : 'PARTIAL',
        suiteFilter,
        declared: MUTATIONS.length,
        selected: selected.length,
        killed,
        survived: survivors,
        outcomes: byOutcome,
        cases: results.map((entry) => ({ id: entry.id, ok: entry.outcome === 'KILLED', expected: 'KILLED', observed: entry.outcome, detail: entry.detail ?? null })),
        failures: results.filter((entry) => entry.outcome !== 'KILLED').map((entry) => `${entry.id}: ${entry.outcome}`),
        result: only === null && suiteFilter === null && survivors === 0 && broken.length === 0 ? 'PASS' : 'FAIL',
      },
      null,
      2,
    )}\n`,
  );
}

// The copy, removed.
//
// `disposeWorkTree` existed and was wired only to the signal handlers, so an
// interrupted run tidied up and a *successful* one did not: every green
// sabotage run left a 142 MB copy of the tree in tmp/sabotage-tree, and the next
// run silently overwrote it. The universe step named "the working tree is
// unchanged after sabotage, tracked and untracked alike" could not see it,
// because its inventory listed sabotage-tree as permitted — an allowlist
// entry that turned out to be covering for exactly the thing the step is named
// after.
//
// Before the exit code, so a run that found survivors still cleans up: the
// mutation results are already written, and leaving a copy of the tree behind
// is not a way of preserving evidence about them.
disposeWorkTree();

if (survivors > 0 || broken.length > 0) {
  process.stderr.write('\nA surviving mutation means the suite does not actually check that behaviour.\n');
  process.exit(1);
}

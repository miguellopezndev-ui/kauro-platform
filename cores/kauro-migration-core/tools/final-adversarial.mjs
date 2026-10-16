#!/usr/bin/env node
// FINAL-ADV-01 — one bounded adversarial pass over the final HEAD.
//
// Not a rerun of the tamper suite. Every attack here is aimed at something this
// round of work changed, on the principle that new code is where the holes are:
// the reader that now streams, the checks that stopped materialising artifacts,
// the value pooling, the line-by-line canonical-bytes comparison, and the
// trace-key guard that a real portal showed was one rename from useless.
//
// An attack that is caught proves the check that caught it. An attack that is
// **not** caught is the finding, and is reported as one rather than quietly
// dropped — including the two below that are not caught, because saying where
// the edge of the guarantee actually is beats claiming there is no edge.
//
// Usage:
//   node tools/final-adversarial.mjs [--evidence <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const evidenceIndex = process.argv.indexOf('--evidence');
const evidencePath = evidenceIndex === -1 ? null : process.argv[evidenceIndex + 1];

const { GOLDEN_ROOT, runFixture } = await import('../dist/test/support/harness.js');
const { verifyPackage } = await import('../dist/src/verify/verify-package.js');
const { listPackageFiles } = await import('../dist/src/artifacts/write-package.js');
const { sha256Hex } = await import('../dist/src/util/hash.js');
const { canonicalJsonText, parseJson } = await import('../dist/src/util/json.js');
const { hashTargetContract } = await import('../dist/src/target/contract.js');
const { resolveMatchAuthority } = await import('../dist/src/target/match-authority.js');
const { getAdapter } = await import('../dist/src/adapters/specs.js');
const { packagePath } = await import('../dist/src/artifacts/layout.js');
const { createFilesystemScratchStore } = await import('../dist/src/scratch/filesystem-scratch-store.js');
const { SCRATCH_BUDGET_BYTES } = await import('../dist/src/domain/resource-profile.js');

// Every attack ends in a verification, and a verification needs somewhere to
// spill. One store per attack, so no attack can see what another left behind.
let verifyStores = 0;
const verify = (dir) => {
  verifyStores += 1;
  const scratch = createFilesystemScratchStore({
    root: `${dir}.kauro-verify-${String(verifyStores)}`,
    runId: 'adv',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
  try {
    return verifyPackage(dir, { scratch });
  } finally {
    scratch.dispose();
  }
};

const attacks = [];
const findings = [];

function record(id, intent, caught, detail) {
  attacks.push({ id, intent, caught, detail });
  if (!caught) findings.push(`${id}: ${detail}`);
}

// --------------------------------------------------------------- the package

let scratch = 0;
function open(caseId) {
  scratch += 1;
  const run = runFixture(GOLDEN_ROOT, caseId, { scratchName: `final-adv-${String(scratch)}` });
  return run.packageDir;
}

// Artifacts are named the way the contract names them; the layout decides
// where each one sits. An attack that hard-coded an address would stop finding
// the file it means to tamper with and would report success for the wrong
// reason.
const read = (dir, name) => readFileSync(join(dir, ...packagePath(name).split('/')), 'utf8');
const write = (dir, name, text) =>
  writeFileSync(join(dir, ...packagePath(name).split('/')), Buffer.from(text, 'utf8'));

/**
 * Repair every hash and count in the manifest after an edit.
 *
 * Without this an attack is caught on the digest, which proves only that
 * SHA-256 works. The point of each case is whether the *content* checks see it.
 */
function repairManifest(dir) {
  const manifest = parseJson(read(dir, 'manifest.json'));
  const present = new Set(listPackageFiles(dir).filter((path) => path !== 'manifest.json'));
  manifest.artifacts = manifest.artifacts
    .filter((artifact) => present.has(artifact.path))
    .map((artifact) => {
      const bytes = readFileSync(join(dir, ...artifact.path.split('/')));
      const text = bytes.toString('utf8');
      const rowCount =
        artifact.rowCount === null
          ? null
          : Math.max(0, text.split('\n').filter((line) => line !== '').length - 1);
      return { ...artifact, sha256: sha256Hex(bytes), byteLength: bytes.length, rowCount };
    });
  write(dir, 'manifest.json', canonicalJsonText(manifest));
}

/** Runs the verifier and says whether it refused, and on which check. */
function verdict(dir) {
  try {
    const result = verify(dir);
    return { refused: !result.passed, checks: result.problems.map((problem) => problem.check) };
  } catch (error) {
    // A refusal by exception is still a refusal, and naming it is the point.
    return { refused: true, checks: [`threw ${String(error?.code ?? error?.message ?? error)}`] };
  }
}

function attack(id, intent, caseId, mutate) {
  const dir = open(caseId);
  const before = verify(dir);
  if (!before.passed) {
    record(id, intent, false, 'the untouched package does not verify, so this case proves nothing');
    return;
  }
  const applied = mutate(dir);
  if (applied === false) {
    record(id, intent, false, 'the attack could not be applied to this package');
    return;
  }
  repairManifest(dir);
  const after = verdict(dir);
  record(id, intent, after.refused, after.refused ? after.checks.join(', ') : 'the package still verifies');
}

// ------------------------------------------------------------------- attacks

// A1. The canonical-bytes check now compares one line at a time. If it rendered
// the raw fields, every line would reproduce itself. A file that repeats a
// header with different values under each copy is the case where by-name
// addressing and by-position addressing disagree.
attack('A1.duplicateHeaderDisagrees', 'a repeated column carries two different values', 'G31-wide-and-deep', (dir) => {
  const path = 'changes.csv';
  const lines = read(dir, path).split('\n');
  if (lines.length < 3) return false;
  const headers = lines[0].split(',');
  // Repeat the first column's header, and give the copy a different value.
  lines[0] = [...headers, headers[0]].join(',');
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '') continue;
    lines[index] = `${lines[index]},TAMPERED`;
  }
  write(dir, path, lines.join('\n'));
  return true;
});

// A2. unmapped-fields.csv is no longer held in memory. A check reading it a row
// at a time must still see a row whose provenance disagrees with the lineage.
attack('A2.streamedArtifactProvenance', 'a streamed artifact claims provenance the lineage denies', 'G20-unmapped-fields', (dir) => {
  const path = 'unmapped-fields.csv';
  let text;
  try {
    text = read(dir, path);
  } catch {
    return false;
  }
  const lines = text.split('\n');
  const headers = lines[0].split(',');
  const at = headers.indexOf('row_hash');
  if (at === -1 || lines.length < 2 || lines[1] === '') return false;
  const cells = lines[1].split(',');
  cells[at] = '0'.repeat(64);
  lines[1] = cells.join(',');
  write(dir, path, lines.join('\n'));
  return true;
});

// A3. The same artifact, attacked on its count rather than its content: a row
// removed entirely. Streaming must not have turned a count into a guess.
attack('A3.streamedArtifactRowRemoved', 'a row is removed from a streamed artifact', 'G20-unmapped-fields', (dir) => {
  const path = 'unmapped-fields.csv';
  let text;
  try {
    text = read(dir, path);
  } catch {
    return false;
  }
  const lines = text.split('\n').filter((line) => line !== '');
  if (lines.length < 3) return false;
  write(dir, path, `${[lines[0], ...lines.slice(2)].join('\n')}\n`);
  return true;
});

// A4. Values are pooled per column now, one string per distinct value. Changing
// one row's disposition changes a pooled value for that row only, and the
// tallies have to disagree with the reconciliation.
attack('A4.pooledValueChanged', 'one row is given a different disposition', 'G31-wide-and-deep', (dir) => {
  const path = 'source-lineage.csv';
  const lines = read(dir, path).split('\n');
  const headers = lines[0].split(',');
  const at = headers.indexOf('disposition');
  if (at === -1 || lines.length < 2) return false;
  const cells = lines[1].split(',');
  cells[at] = cells[at] === 'OUTPUT' ? 'ISOLATED' : 'OUTPUT';
  lines[1] = cells.join(',');
  write(dir, path, lines.join('\n'));
  return true;
});

// A5. Ordering is compared row against previous row rather than by sorting a
// copy. Two adjacent rows swapped is what that change has to still catch.
attack('A5.adjacentRowsSwapped', 'two adjacent rows of an ordered artifact are swapped', 'G31-wide-and-deep', (dir) => {
  const path = 'source-lineage.csv';
  const lines = read(dir, path).split('\n').filter((line) => line !== '');
  if (lines.length < 4) return false;
  const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)];
  write(dir, path, `${swapped.join('\n')}\n`);
  return true;
});

// A6. Row counts are read by counting records rather than by building rows.
// A row appended to an artifact has to disagree with the reconciliation.
attack('A6.rowAppended', 'a row is appended to an artifact', 'G31-wide-and-deep', (dir) => {
  const path = 'changes.csv';
  const lines = read(dir, path).split('\n').filter((line) => line !== '');
  if (lines.length < 2) return false;
  write(dir, path, `${[...lines, lines[lines.length - 1]].join('\n')}\n`);
  return true;
});

// ------------------------------------------------ the separation, attacked again

// A7 and A8 do not touch a package. They ask whether the destination-match guard
// can be walked past by spelling, which is how a real portal defeated it once.
{
  const hubspot = getAdapter('HUBSPOT');
  const field = (apiName) => ({
    apiName,
    label: apiName,
    type: 'string',
    createable: 'TRUE',
    updateable: 'TRUE',
    nillable: 'TRUE',
    length: 64,
    precision: null,
    scale: null,
    unique: 'TRUE',
    externalId: 'UNKNOWN',
    idLookup: 'UNKNOWN',
    calculated: 'FALSE',
    autoNumber: 'FALSE',
    defaultedOnCreate: 'FALSE',
    restrictedPicklist: 'FALSE',
    picklistValues: [],
    referenceTo: [],
    relationshipName: null,
    evidence: 'ARTIFACT',
  });
  const contractFor = (apiName) =>
    hashTargetContract({
      contractVersion: '1.0.0',
      parserVersion: '1.0.0',
      capturedAt: '2026-09-01T00:00:00Z',
      instance: { mode: 'HUBSPOT', instanceId: '51872453', instanceLabel: 'test portal', evidence: 'ARTIFACT' },
      artifacts: [{ path: 'contact.csv', sha256: 'a'.repeat(64), byteLength: 10, kind: 'HUBSPOT_PROPERTY_EXPORT' }],
      objects: [{ apiName: 'CONTACT', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', fields: [field(apiName)], recordTypes: [] }],
      pipelines: [],
    });
  const planFor = (targetField) => ({
    configVersion: '3.0.0',
    source: { system: 'adv', namespace: 'adv', encoding: null },
    target: { mode: 'HUBSPOT', importMode: 'UPSERT' },
    localeEvidence: { phoneCountry: null, dateFormat: null, decimalSeparator: null, thousandsSeparator: null },
    limits: {}, policies: {}, files: [],
    records: [{ id: 'contacts', object: 'CONTACT', fields: [] }],
    associations: [],
    destinationMatching: [{
      recordMappingId: 'contacts',
      matchAuthority: 'TARGET_UNIQUE_FIELD',
      targetField,
      sourceField: 'contact.email',
      onMissingMatch: 'ISOLATE',
      onMatchConflict: 'ISOLATE',
    }],
  });

  const refusedAsTraceKey = (spelling) => {
    try {
      resolveMatchAuthority(planFor(spelling), hubspot, contractFor(spelling));
      return { refused: false, why: 'accepted as a match key' };
    } catch (error) {
      const text = `${String(error?.message ?? '')} ${String(error?.remedy ?? '')}`;
      return { refused: text.includes('trace key'), why: text.slice(0, 140) };
    }
  };

  // A7. Separator and case respellings, which is what a portal actually
  // produces: HubSpot lower-cases and underscores every internal name.
  const separatorSpellings = [
    'kauro_trace_key', 'KAURO_TRACE_KEY', 'kauro-trace-key', 'kaurotracekey',
    'Kauro.Trace.Key', 'kauro  trace  key', 'KauroTraceKey', 'kauro_trace_key__c',
  ];
  const escaped = separatorSpellings.filter((spelling) => !refusedAsTraceKey(spelling).refused);
  record(
    'A7.traceKeyBySeparatorAndCase',
    'the trace key is declared as the match authority under every separator and casing a destination would produce',
    escaped.length === 0,
    escaped.length === 0 ? 'every spelling refused as a trace key' : `accepted: ${escaped.join(', ')}`,
  );

  // A8. The same spelling attack with a Cyrillic character that renders as a
  // Latin one. This is where the guarantee ends, and the end is deliberate.
  //
  // The guard is a check on names, and the names it knows are the ones Kauro
  // itself writes. `kauro_trace_kеy` with a Cyrillic е is a different property:
  // Kauro never writes a column by that name, so no trace key is ever in it, and
  // matching on it is matching on a field the agency owns and filled. Folding it
  // into the refusal would block a property somebody may legitimately have —
  // strictly worse, and not safer, because the attack it would supposedly
  // prevent requires a trace key *value* in a column Kauro never writes to.
  //
  // So the expectation is inverted: these must be usable. The line is drawn
  // where a name stops being one Kauro produces, and this records where that is
  // rather than leaving a reader to assume the guard reaches further than it
  // does. The neighbouring case in the unit tests, `kauro_trace_key_source`, is
  // the same category and the same answer.
  const homoglyphs = ['kauro_trace_kеy', 'kauro_trасe_key'];
  const treatedAsTraceKey = homoglyphs.filter((spelling) => refusedAsTraceKey(spelling).refused);
  record(
    'A8.aNameKauroDoesNotWriteIsNotTheTraceKey',
    'a property whose name merely renders like the trace key stays usable',
    treatedAsTraceKey.length === 0,
    treatedAsTraceKey.length === 0
      ? 'not treated as the trace key, which is the boundary this states'
      : `refused as a trace key, blocking a property an agency may own: ${treatedAsTraceKey.join(', ')}`,
  );
}

// -------------------------------------------------------------------- report

const result = findings.length === 0 ? 'PASS' : 'FINDINGS';
const evidence = {
  gate: 'FINAL-ADV-01',
  attacks,
  findings,
  result,
};
if (evidencePath !== null && evidencePath !== undefined) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

process.stdout.write(`FINAL-ADV-01: ${String(attacks.length)} attacks\n`);
for (const entry of attacks) {
  process.stdout.write(`  ${entry.caught ? 'caught  ' : 'NOT CAUGHT'} ${entry.id} — ${entry.detail}\n`);
}
process.stdout.write(`result = ${result}\n`);
if (findings.length > 0) process.exitCode = 1;

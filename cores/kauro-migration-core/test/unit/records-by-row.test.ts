import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ResolvedRecord } from '../../src/identity/resolve-identity.js';
import type { RowAddress } from '../../src/reconcile/truth.js';
import { spillRecordsByRow } from '../../src/run/records-by-row.js';
import type { RowRecord } from '../../src/run/records-by-row.js';
import { materialisedFamily } from '../../src/run/spool.js';
import type { ScratchStore } from '../../src/scratch/scratch-store.js';
import { describeConflict } from '../../src/identity/resolve-identity.js';
import { runInline, textField } from '../support/inline.js';
import { GOLDEN_ROOT, caseScratch, collect, runFixture } from '../support/harness.js';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which record a source row went into, for a cluster of n rows.
 *
 * The defect (B01-R7): the entry written for a member row carried the whole
 * member list, so a cluster of n rows wrote n copies of an n-member list and its
 * spill grew with n squared. At 20 members the probe measured 63,152 bytes and
 * at 40 it measured 242,312. The cases below state the two properties that make
 * it linear: a cluster's membership is written once, and a row entry names only
 * its own member and the survivor.
 */

function addressOf(index: number): RowAddress {
  const rowNumberSource = index + 2;
  return {
    bundleId: 'bundle-0123456789abcdef',
    fileId: 'contacts',
    fileSha256: 'a'.repeat(64),
    filePath: 'contacts.csv',
    sheetId: 'S0',
    sheetName: null,
    rowNumberSource,
    rowLocatorId: `row-locator-${String(rowNumberSource).padStart(6, '0')}`,
    rowHash: 'b'.repeat(64),
  };
}

function clusterOf(size: number): ResolvedRecord {
  const members = Array.from({ length: size }, (_unused, index) => ({
    address: addressOf(index),
    recordMappingId: 'contacts',
    object: 'CONTACT' as const,
    sourceSystem: 'generic_csv',
    sourceNamespace: 'cluster-case',
    sourceRecordId: `ID-${String(index)}`,
    identityKey: 'shared-legacy-id',
    identitySpace: 'contacts',
    signals: new Map<string, string>([['EMAIL', `member${String(index)}@example.com`]]),
  }));
  const survivor = members[0];
  assert.ok(survivor !== undefined);
  return {
    migrationKey: 'mk-cluster',
    canonicalIdentityKey: 'shared-legacy-id',
    object: 'CONTACT',
    recordMappingId: 'contacts',
    survivor,
    members,
    values: new Map(),
    mergeId: 'merge-1',
    isolation: null,
  };
}

function bytesWrittenBy(store: ScratchStore, run: () => void): number {
  const before = store.usage().bytesWritten;
  run();
  return store.usage().bytesWritten - before;
}

function spillBytes(size: number): number {
  const scratch = caseScratch(`records-by-row-${String(size)}`);
  return bytesWrittenBy(scratch, () => {
    const byRow = spillRecordsByRow(scratch, materialisedFamily([clusterOf(size)]));
    // Reading it back is part of the cost of having written it.
    const cursor = byRow.open();
    for (let index = 0; index < size; index += 1) cursor.at(addressOf(index));
    byRow.release();
  });
}

/** Every line of the segments a family wrote, read back from the store. */
function linesOfFamily(store: ScratchStore, family: string): string[] {
  const lines: string[] = [];
  for (const manifest of store.list()) {
    if (manifest.schema !== family) continue;
    for (const line of store.readLines(manifest.segmentId)) lines.push(line);
  }
  return lines;
}

describe('the record each source row went into', () => {
  it("[S031] a cluster's membership is written once: 2n members spill at most 2.2x the bytes of n", () => {
    const at20 = spillBytes(20);
    const at40 = spillBytes(40);
    const at80 = spillBytes(80);
    assert.ok(at20 > 0, 'the cluster wrote nothing, so the measurement measures nothing');
    assert.ok(at40 <= at20 * 2.2, `40 members wrote ${String(at40)} bytes against ${String(at20)} for 20`);
    assert.ok(at80 <= at40 * 2.2, `80 members wrote ${String(at80)} bytes against ${String(at40)} for 40`);
  });

  it('[S031] each row entry names only its own member and the survivor', () => {
    const size = 12;
    const cluster = clusterOf(size);
    const scratch = caseScratch('records-by-row-entries');
    const byRow = spillRecordsByRow(scratch, materialisedFamily([cluster]));

    // What is written under the rows: a line names the member the row is, the
    // survivor, and nobody else of the cluster.
    const lines = linesOfFamily(scratch, 'records-by-row');
    assert.equal(lines.length, size, 'one entry per member row');
    const survivorLocator = cluster.survivor.address.rowLocatorId;
    for (const line of lines) {
      const named = cluster.members
        .map((member) => member.address.rowLocatorId)
        .filter((locator) => line.includes(locator));
      assert.ok(named.length <= 2, `an entry names ${String(named.length)} rows of the cluster: ${named.join(', ')}`);
      assert.ok(named.includes(survivorLocator), 'an entry names the survivor');
    }

    // What is read back: the row, the survivor and the merge, with no list.
    const cursor = byRow.open();
    cluster.members.forEach((member, index) => {
      const entry = cursor.at(addressOf(index)) as (RowRecord & { members?: unknown; member?: { rowLocatorId: string; sourceRecordId: string | null } }) | null;
      assert.ok(entry !== null, `row ${String(index)} has a record`);
      assert.equal(entry.migrationKey, 'mk-cluster');
      assert.equal(entry.mergeId, 'merge-1');
      assert.equal(entry.survivor.rowLocatorId, survivorLocator);
      assert.equal(entry.member?.rowLocatorId, member.address.rowLocatorId, 'the entry names its own member');
      assert.equal(entry.member?.sourceRecordId, member.sourceRecordId, 'and what that member called itself');
      assert.equal(entry.members, undefined, 'the entry carries no member list');
    });

    // The membership exists once, is read by a cursor that only moves forward,
    // and is asked for by the survivor's row.
    const membership = byRow.open() as unknown as {
      membersAt?: (address: RowAddress) => readonly { rowLocatorId: string; sourceRecordId: string | null }[] | null;
    };
    assert.equal(typeof membership.membersAt, 'function', 'the cursor answers who a record absorbed');
    const members = membership.membersAt?.(cluster.survivor.address) ?? null;
    assert.deepEqual(
      members?.map((member) => member.rowLocatorId),
      cluster.members.map((member) => member.address.rowLocatorId),
    );
    assert.deepEqual(
      members?.map((member) => member.sourceRecordId),
      cluster.members.map((member) => member.sourceRecordId),
    );
    byRow.release();
  });

  it('[S031] the survivor of a set-aside merge still says how many rows it absorbed', () => {
    // G27: three rows share one contact id and two of them disagree about the
    // job title, so the record is set aside. The survivor is the first row, and
    // the other two were absorbed -- a count that now comes from the membership
    // written once, where it used to come from a list in every entry.
    // Its own scratch name: the golden suite runs G27 in another process under the
    // case id, and a shared directory let one clear the other's package mid-read.
    const run = runFixture(GOLDEN_ROOT, 'G27-prefer-survivor-empty', { scratchName: 'records-by-row-G27' });
    const isolated = collect(run.result.truth.isolated);
    assert.equal(isolated.length, 1);
    assert.ok(
      (isolated[0]?.detail ?? '').endsWith('(this record also absorbed 2 other row(s))'),
      isolated[0]?.detail,
    );
  });
});

/**
 * B01-R7, second half: the isolation detail of a merge was copied into every
 * member's entry, and it listed every distinct conflicting value, so n rows
 * wrote n sentences of n values. The sentence is bounded now. These cases
 * measure it, and measure the old sentence with the same instrument so the
 * instrument is shown to catch the defect it guards against.
 */
function distinctValues(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `Distinct first name number ${String(index).padStart(6, '0')} ${'x'.repeat(80)}`);
}

/** The sentence as it was before the bound: every distinct value, in full. */
function unboundedDetail(field: string, values: string[]): string {
  return `rows proven to be one record disagree on "${field}": ${[...new Set(values)].sort().map((value) => `"${value}"`).join(' vs ')}`;
}

function spillBytesWithDetail(size: number, detailOf: (values: string[]) => string): number {
  const scratch = caseScratch(`records-by-row-isolated-${String(size)}`);
  const cluster = {
    ...clusterOf(size),
    isolation: { reasonCode: 'ISOLATED_IDENTITY_CONFLICT' as const, detail: detailOf(distinctValues(size)) },
  };
  return bytesWrittenBy(scratch, () => {
    spillRecordsByRow(scratch, materialisedFamily([cluster])).release();
  });
}

function directoryBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const stat = statSync(join(dir, name));
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

describe('an isolated merge does not spill its conflict detail once per row (B01-R7)', () => {
  const LINEAR_BOUND = 4.4; // 4n rows may write at most 4.4x the bytes of n rows
  const bounded = (values: string[]): string => describeConflict('contact.firstName', values);

  it('[B01-R7] the detail sentence has a fixed bound however many values conflict', () => {
    assert.ok(bounded(distinctValues(20)).length <= 1000);
    assert.ok(bounded(distinctValues(2000)).length <= 1000);
    assert.ok(bounded(distinctValues(2000)).endsWith('and 1995 more'));
  });

  it('[B01-R7] 4n merged rows with distinct conflicts spill at most 4.4x the bytes of n', () => {
    const at20 = spillBytesWithDetail(20, bounded);
    const at80 = spillBytesWithDetail(80, bounded);
    assert.ok(at80 <= at20 * LINEAR_BOUND, `80 rows wrote ${String(at80)} bytes against ${String(at20)} for 20`);
  });

  it('[B01-R7] mutation: the unbounded per-row sentence fails the same measure', () => {
    const at20 = spillBytesWithDetail(20, (values) => unboundedDetail('contact.firstName', values));
    const at80 = spillBytesWithDetail(80, (values) => unboundedDetail('contact.firstName', values));
    assert.ok(at80 > at20 * LINEAR_BOUND, 'the old sentence must grow faster than linear, or the measure measures nothing');
  });

  it('[B01-R7] end to end: a package of 4n conflicting duplicates is at most 4.4x the bytes of n, and verifies', () => {
    const fields = [textField('First Name', 'contact.firstName')];
    const sizes = [20, 80].map((size) => {
      const ran = runInline(`b01-r7-${String(size)}`, {
        headers: ['Contact ID', 'First Name'],
        rows: distinctValues(size).map((value) => ['SAME-ID', value]),
        fields,
      });
      assert.deepEqual(ran.verification.problems, []);
      const isolated = collect(ran.run.truth.isolated);
      assert.equal(isolated.length, 1);
      assert.ok((isolated[0]?.detail ?? '').length <= 1100);
      return directoryBytes(ran.packageDir);
    });
    assert.ok((sizes[1] ?? 0) <= (sizes[0] ?? 1) * LINEAR_BOUND, `package grew ${JSON.stringify(sizes)}`);
  });
});

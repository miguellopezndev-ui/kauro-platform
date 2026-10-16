import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as buildEdges from '../../src/associations/build-edges.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { coGroup } from '../../src/verify/join.js';
import type { Group, Keyed } from '../../src/verify/join.js';
import type { ScratchStore } from '../../src/scratch/scratch-store.js';
import { createFilesystemScratchStore } from '../../src/scratch/filesystem-scratch-store.js';
import { attestationFor } from '../../tools/attestation-fixture.js';
import { caseScratch, scratchDir } from '../support/harness.js';

/**
 * The join the relationship builder stands on, under a skewed key (B02-R3).
 *
 * `coGroup` collected every equal-key row into two arrays before it yielded, so
 * a join was proportional to its hottest bucket however much of the input had
 * been spilled, and the distinct-target dedupe compared every target with every
 * one kept. These cases state the bounds: a hot key is read in pieces, the
 * pieces are bounded, the dedupe is one pass, and the edges a hot parent owns
 * are all there, counted from the source rather than from the join.
 */

interface BoundedOptions {
  readonly bound: number;
  readonly scratch?: ScratchStore;
}
type BoundedCoGroup = <L, R>(
  left: Iterable<Keyed<L>>,
  right: Iterable<Keyed<R>>,
  options: BoundedOptions,
) => IterableIterator<Group<L, R>>;
const boundedCoGroup = coGroup as unknown as BoundedCoGroup;

/** A generator that says how much of it has been read. */
function counted<T>(
  count: number,
  key: string,
  value: (index: number) => T,
): { read: { n: number }; rows: Iterable<Keyed<T>> } {
  const read = { n: 0 };
  function* rows(): IterableIterator<Keyed<T>> {
    for (let index = 0; index < count; index += 1) {
      read.n += 1;
      yield { k: key, v: value(index) };
    }
  }
  return { read, rows: { [Symbol.iterator]: rows } };
}

interface Target {
  keyRaw: string;
  migrationKey: string;
  isolatedDetail: string | null;
}

describe('a join under a skewed key', () => {
  const BOUND = 1_000;

  it("[R2-016] coGroup yields a hot key's first group after a bounded read and holds at most its buffer bound", () => {
    const children = counted(100_000, 'hot', (index) => index);
    const parents = counted(1, 'hot', () => 'parent');
    const groups = boundedCoGroup(children.rows, parents.rows, { bound: BOUND });

    const first = groups.next();
    assert.equal(first.done, false);
    assert.ok(
      children.read.n <= 2 * BOUND,
      `the first group was yielded after ${String(children.read.n)} of 100000 entries were read`,
    );
    assert.ok(first.value.left.length <= BOUND, `the first group holds ${String(first.value.left.length)} entries`);
    assert.deepEqual(first.value.right, ['parent'], 'the parent comes with every piece of the hot side');

    // The rest of the key arrives in pieces no larger than the bound, in order,
    // and nothing is lost or repeated.
    let widest = first.value.left.length;
    let seen = first.value.left.length;
    let expectedNext = 0;
    for (const entry of first.value.left) {
      assert.equal(entry, expectedNext);
      expectedNext += 1;
    }
    for (const group of groups) {
      widest = Math.max(widest, group.left.length);
      assert.equal(group.key, 'hot');
      assert.deepEqual(group.right, ['parent']);
      for (const entry of group.left) {
        assert.equal(entry, expectedNext, 'the hot side arrives in the order it was written');
        expectedNext += 1;
      }
      seen += group.left.length;
    }
    assert.ok(widest <= BOUND, `a group held ${String(widest)} entries`);
    assert.equal(seen, 100_000);
  });

  it('[R2-016] a hot right side is read in pieces as well, each with the whole of the small side', () => {
    const owners = counted(1, 'hot', () => 'child');
    const targets = counted(100_000, 'hot', (index) => index);
    const groups = boundedCoGroup(owners.rows, targets.rows, { bound: BOUND });
    const first = groups.next();
    assert.equal(first.done, false);
    assert.ok(targets.read.n <= 2 * BOUND, `the first group was yielded after ${String(targets.read.n)} entries`);
    assert.ok(first.value.right.length <= BOUND);
    assert.deepEqual(first.value.left, ['child']);
    let seen = first.value.right.length;
    for (const group of groups) {
      assert.ok(group.right.length <= BOUND);
      seen += group.right.length;
    }
    assert.equal(seen, 100_000);
  });

  it('[R2-016] a key hot on both sides meets every pair once, from a bucket held in scratch', () => {
    const scratch = caseScratch('join-hot-both');
    const left = counted(250, 'hot', (index) => `l${String(index)}`);
    const right = counted(230, 'hot', (index) => `r${String(index)}`);
    const pairs = new Set<string>();
    let total = 0;
    for (const group of boundedCoGroup(left.rows, right.rows, { bound: 100, scratch })) {
      assert.ok(group.left.length <= 100 && group.right.length <= 100, 'both sides stay within the bound');
      for (const l of group.left) {
        for (const r of group.right) {
          pairs.add(`${l}|${r}`);
          total += 1;
        }
      }
    }
    assert.equal(total, 250 * 230, 'no pair is repeated');
    assert.equal(pairs.size, 250 * 230, 'no pair is missing');
  });

  it('[R2-016] distinct targets of a key shared by n parents are found in linear work', () => {
    const distinctTargets = (buildEdges as unknown as Record<string, unknown>)['distinctTargets'] as
      | ((entries: Iterable<Keyed<Target>>) => Iterable<Keyed<Target>>)
      | undefined;
    assert.equal(typeof distinctTargets, 'function', 'build-edges exports distinctTargets');

    const measure = (parents: number): { work: number; distinct: number } => {
      let reads = 0;
      const entries: Keyed<Target>[] = [];
      for (let index = 0; index < parents; index += 1) {
        const migrationKey = `mk-${String(index).padStart(8, '0')}`;
        // A record that answers to the key twice is written twice, adjacently.
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const target = { keyRaw: 'shared', isolatedDetail: null } as Target;
          Object.defineProperty(target, 'migrationKey', {
            enumerable: true,
            get(): string {
              reads += 1;
              return migrationKey;
            },
          });
          entries.push({ k: 'shared', v: target });
        }
      }
      const distinct = [...(distinctTargets?.(entries) ?? [])];
      return { work: reads, distinct: distinct.length };
    };

    const small = measure(1_000);
    const large = measure(4_000);
    assert.equal(small.distinct, 1_000);
    assert.equal(large.distinct, 4_000);
    assert.ok(small.work <= 6 * 1_000, `1000 parents took ${String(small.work)} comparisons`);
    assert.ok(large.work <= 6 * 4_000, `4000 parents took ${String(large.work)} comparisons`);
  });

  it('[R2-016] 100000 children of one parent give 100000 edges, counted independently of the join', () => {
    const children = 100_000;
    const dir = scratchDir('join-hot-parent');
    const inputDir = join(dir, 'input');
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(join(inputDir, 'companies.csv'), 'Company ID,Name\nA-0,Hot Parent\n', 'utf8');
    const lines = ['Contact ID,First Name,Company ID'];
    for (let index = 0; index < children; index += 1) lines.push(`C-${String(index)},First${String(index % 97)},A-0`);
    writeFileSync(join(inputDir, 'contacts.csv'), `${lines.join('\n')}\n`, 'utf8');

    const config = {
      configVersion: '3.0.0',
      source: { system: 'generic_csv', namespace: 'hot-parent' },
      target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
      files: [
        { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
        { id: 'companies', path: 'companies.csv', format: 'CSV' },
      ],
      records: [
        {
          id: 'contacts',
          fileId: 'contacts',
          object: 'CONTACT',
          sourceRecordIdColumn: { header: 'Contact ID' },
          fields: [{ column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' }],
        },
        {
          id: 'companies',
          fileId: 'companies',
          object: 'COMPANY',
          sourceRecordIdColumn: { header: 'Company ID' },
          fields: [{ column: { header: 'Name' }, destinationField: 'company.name', semanticType: 'TEXT' }],
        },
      ],
      associations: [
        {
          id: 'contact-company',
          kind: 'COLUMN_REFERENCE',
          recordMappingId: 'contacts',
          relationshipType: 'CONTACT_TO_COMPANY',
          keyColumn: { header: 'Company ID' },
          targetRecordMappingId: 'companies',
          targetMatchKey: 'SOURCE_RECORD_ID',
        },
      ],
    };
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);

    // The expected count comes from the source's own relationship column: the
    // rows of contacts.csv whose last cell names a company. It does not come
    // from the engine, the join or any family.
    const named = readFileSync(join(inputDir, 'contacts.csv'), 'utf8')
      .split('\n')
      .slice(1)
      .filter((line) => line.length > 0 && (line.split(',')[2] ?? '').length > 0).length;
    assert.equal(named, children);

    const result = runMigration({
      inputRoot: inputDir,
      config: loaded.config,
      configHash: loaded.configHash,
      // A hundred thousand rows spill about two gigabytes over a run, which is
      // more than the harness's default quota allows a case; the quota is the
      // only thing this raises.
      scratch: createFilesystemScratchStore({
        root: scratchDir('join-hot-parent-work'),
        runId: 'case',
        quotaBytes: 8 * 1024 * 1024 * 1024,
      }),
      ...attestationFor(loaded.config.target.mode),
    });
    const associations = result.reconciliation.associations;
    assert.equal(associations.sourceEdges, named, 'the source asserted one relationship per child');
    assert.equal(associations.byDisposition.OUTPUT, named, 'every one of them resolved to the parent');
    assert.equal(associations.byDisposition.UNRESOLVED, 0);
    assert.equal(associations.equationHolds, true);
    let delivered = 0;
    for (const edge of result.truth.edges) {
      if (edge.disposition === 'OUTPUT' && edge.toKeyRaw === 'A-0') delivered += 1;
    }
    assert.equal(delivered, named, 'and the edge family holds them all');
  });
});

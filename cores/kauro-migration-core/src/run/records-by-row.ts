import type { CanonicalObject } from '../domain/canonical.js';
import type { ResolvedRecord } from '../identity/resolve-identity.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import type { RowOrderAddress, SpooledFamily } from './spool.js';
import { openFamily, rowOrderKey } from './spool.js';
import { compareCodeUnits } from '../util/json.js';

/**
 * What a row's record is, for the two stages that ask a row that question.
 *
 * This used to be the whole `ResolvedRecord`, spilled once per member row, and
 * it made 'records-by-row' the largest family the run wrote -- larger than the
 * records family it was copying, because each entry carried the record *and* a
 * full row address to key it by.
 *
 * Neither reader needs a record. The lineage pass reads the survivor's row, the
 * row's own member and what it called itself, the object, the mapping, the
 * identity keys, the merge and the isolation. Relationship building reads the
 * migration key, the isolation detail, and the source record ids of the
 * survivor and of the row's own member. Between them that is this type; the
 * values the record delivers, the signal maps its members carried, and the file
 * digests and row hashes on their addresses are read by neither, and a fact
 * nothing reads is a fact that does not need writing down.
 *
 * It also used to carry the record's complete member list, in every entry. A
 * cluster of n rows wrote n copies of an n-member list (B01-R7): 63,152 bytes
 * at 20 members and 242,312 at 40. An entry now names its own member and the
 * survivor, and the membership is written once, in a family of its own.
 */
export interface RowRecordMember {
  readonly rowLocatorId: string;
  readonly recordMappingId: string;
  readonly sourceSystem: string;
  readonly sourceNamespace: string;
  readonly sourceRecordId: string | null;
  /** The first proving key this row held, or null if it held none. */
  readonly identityKey: string | null;
}

export interface RowRecord {
  readonly migrationKey: string;
  readonly canonicalIdentityKey: string | null;
  readonly object: CanonicalObject;
  readonly recordMappingId: string;
  /** The first member of the record: the row whose values it delivers. */
  readonly survivor: RowRecordMember;
  /**
   * The member this row is. Not the record's members: a cluster of n rows has n
   * entries, and an entry that listed the cluster would make the family n
   * squared. The record's full membership is asked for separately, once, by the
   * survivor's row -- see `RecordCursor.membersAt`.
   */
  readonly member: RowRecordMember;
  readonly mergeId: string | null;
  readonly isolation: {
    readonly reasonCode: ReasonCode;
    readonly detail: string;
    readonly field?: string | null;
  } | null;
}

/**
 * Which record a source row went into, without an index of every record.
 *
 * Two stages ask this question -- the pass that writes the lineage, and the one
 * that resolves relationships -- and both ask it while walking a sheet in the
 * order its rows are written. So the answer is a family keyed by the row each
 * record was built from, walked alongside the sheet rather than looked up.
 *
 * A record built from several rows appears once per row: the merge that produced
 * it is why the question has an answer for every member and not only for the
 * survivor. What each of those entries holds is the row's own member and the
 * survivor, and nothing about the other members. The membership is a second
 * family, keyed by the record's survivor row and written once per record.
 */
export interface RecordsByRow {
  /** A cursor over the whole family, from the first row. */
  open(): RecordCursor;
  /**
   * Discards the family. Every cursor already handed out is finished with it,
   * and a new one would fail on the missing segment rather than read nothing.
   */
  release(): void;
}

export interface RecordCursor {
  /**
   * The record this row went into, or null if it went into none.
   *
   * Addresses must be asked for in the order the family is written in, which is
   * the order every sheet is walked in. A cursor that is asked to go backwards
   * says so rather than answering wrongly.
   */
  at(address: RowOrderAddress): RowRecord | null;
  /**
   * Every member of the record whose survivor is this row, in the record's
   * order with the survivor first -- or null when the row is not the survivor of
   * a record of more than one row (a record of one row is its own membership,
   * and is not written down).
   *
   * Read by a forward cursor of its own, over a family written once per record,
   * so it obeys the same order rule as `at`. Only the stage that reports what a
   * merge absorbed needs it, and it asks at the survivor's row.
   */
  membersAt(address: RowOrderAddress): readonly RowRecordMember[] | null;
}

/**
 * The address the entry is keyed by, and nothing more.
 *
 * The entry used to carry a whole `RowAddress` -- bundle id, file id, file
 * digest, sheet name, row locator, row hash -- and the only thing read from it
 * was `rowOrderKey`, which is three of those fields. The digests alone were 128
 * hex characters per entry, written once per source row that produced a record.
 */
interface RowEntry {
  readonly address: RowOrderAddress;
  readonly record: RowRecord;
}

/** A record of more than one row, written once under its survivor's row. */
interface MembershipEntry {
  readonly address: RowOrderAddress;
  readonly members: readonly RowRecordMember[];
}

function memberOf(member: ResolvedRecord['members'][number]): RowRecordMember {
  return {
    rowLocatorId: member.address.rowLocatorId,
    recordMappingId: member.recordMappingId,
    sourceSystem: member.sourceSystem,
    sourceNamespace: member.sourceNamespace,
    sourceRecordId: member.sourceRecordId,
    identityKey: member.identityKey,
  };
}

function orderAddressOf(member: ResolvedRecord['members'][number]): RowOrderAddress {
  return {
    filePath: member.address.filePath,
    sheetId: member.address.sheetId,
    rowNumberSource: member.address.rowNumberSource,
  };
}

/**
 * A forward-only walk of a family ordered by row, answering "is there an entry
 * for this row" for rows asked in that same order.
 */
function forwardCursor<T>(
  family: Iterable<T>,
  addressOf: (entry: T) => RowOrderAddress,
  name: string,
): (address: RowOrderAddress) => T | null {
  const rows = family[Symbol.iterator]();
  let held: T | null = null;
  let exhausted = false;
  let lastAsked: string | null = null;

  const pull = (): void => {
    if (held !== null || exhausted) return;
    const step = rows.next();
    if (step.done === true) {
      exhausted = true;
      return;
    }
    held = step.value;
  };

  return (address) => {
    const wanted = rowOrderKey(address);
    if (lastAsked !== null && compareCodeUnits(lastAsked, wanted) > 0) {
      // Every caller walks a sheet in its own order, and every sheet is written
      // in this one. Going backwards would mean the two had come apart, which is
      // worth failing on rather than answering null.
      throw new Error(`${name} was asked for ${wanted} after ${lastAsked}`);
    }
    lastAsked = wanted;

    for (;;) {
      pull();
      if (held === null) return null;
      const here = rowOrderKey(addressOf(held));
      const order = compareCodeUnits(here, wanted);
      if (order > 0) return null;
      const found: T = held;
      held = null;
      if (order === 0) return found;
    }
  };
}

type StoredRecord = Omit<RowRecord, 'member'> & { readonly member?: RowRecordMember };

export function spillRecordsByRow(
  scratch: ScratchStore,
  records: SpooledFamily<ResolvedRecord>,
): RecordsByRow {
  const rowsWriter = openFamily<RowEntry>(scratch, {
    schema: 'records-by-row',
    key: (entry) => rowOrderKey(entry.address),
    // The survivor is named in every entry so a row can say where it went, and
    // the survivor's own entry writes it once: its member is that same row.
    encode: (entry) => {
      const { member, ...rest } = entry.record;
      const stored: StoredRecord = member.rowLocatorId === rest.survivor.rowLocatorId ? rest : { ...rest, member };
      return JSON.stringify({ address: entry.address, record: stored });
    },
    decode: (line) => {
      const raw = JSON.parse(line) as { address: RowOrderAddress; record: StoredRecord };
      return { address: raw.address, record: { ...raw.record, member: raw.record.member ?? raw.record.survivor } };
    },
  });
  // The membership of each record of more than one row, written once.
  const membershipWriter = openFamily<MembershipEntry>(scratch, {
    schema: 'records-membership',
    key: (entry) => rowOrderKey(entry.address),
  });

  for (const record of records) {
    const members = record.members.map(memberOf);
    const survivor = members[0];
    const survivorSource = record.members[0];
    if (survivor === undefined || survivorSource === undefined) {
      throw new Error(`records-by-row was given a record with no member rows: ${record.migrationKey}`);
    }
    if (members.length > 1) {
      membershipWriter.add({ address: orderAddressOf(survivorSource), members });
    }
    record.members.forEach((source, index) => {
      rowsWriter.add({
        address: orderAddressOf(source),
        record: {
          migrationKey: record.migrationKey,
          canonicalIdentityKey: record.canonicalIdentityKey,
          object: record.object,
          recordMappingId: record.recordMappingId,
          survivor,
          member: members[index] as RowRecordMember,
          mergeId: record.mergeId,
          isolation: record.isolation,
        },
      });
    });
  }
  const rows = rowsWriter.seal();
  const membership = membershipWriter.seal();

  return {
    release(): void {
      rows.release();
      membership.release();
    },
    open(): RecordCursor {
      const rowAt = forwardCursor(rows, (entry) => entry.address, 'records-by-row');
      // Opened when first asked: a run with no merge never asks.
      let membersFrom: ((address: RowOrderAddress) => MembershipEntry | null) | null = null;
      return {
        at(address): RowRecord | null {
          return rowAt(address)?.record ?? null;
        },
        membersAt(address): readonly RowRecordMember[] | null {
          membersFrom ??= forwardCursor(membership, (entry) => entry.address, 'records-membership');
          return membersFrom(address)?.members ?? null;
        },
      };
    },
  };
}

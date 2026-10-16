import { MigrationError } from '../domain/errors.js';
import { MAX_IDENTITY_GROUP_MEMBERS } from '../domain/resource-profile.js';
import type { CanonicalObject } from '../domain/canonical.js';
import type { Policies } from '../domain/config.js';
import type { IdentityEvidence } from '../domain/identity.js';
import { permitsAutomaticMerge } from '../domain/identity.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import { by, onString, sorted } from '../util/sorting.js';
import { compareCodeUnits } from '../util/json.js';
import { CoreInvariantError } from '../util/assert.js';
import type { DraftRecord, DraftValue, ProvingKey } from '../run/build-records.js';
import type { RowAddress } from '../reconcile/truth.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import type { SpooledFamily } from '../run/spool.js';
import { openFamily, orderKey, orderNumber, orderText } from '../run/spool.js';
import type { DuplicateCandidateEntry, MergeConflict, MergeFieldDecision, MergeRecord } from '../reconcile/truth.js';
import { clusterIdFor, mergeIdFor, migrationKeyFromIdentity, migrationKeyFromRow } from './migration-key.js';
import type { ValueIntent } from '../domain/value-intent.js';
import { intendedValue, omit } from '../domain/value-intent.js';

export const IDENTITY_RULE_VERSION = '1.0.0';

export interface ResolvedValue {
  /**
   * What the destination is asked to do with this field once the rows proven to
   * be one record have been combined. A clear survives the merge as a clear.
   */
  readonly intent: ValueIntent;
  /**
   * There is no `fromRowLocatorId` here, and there was.
   *
   * It was written on every value of every record -- a row locator per field
   * per record -- and read by nothing. Which row a merge took a value from is a
   * question the package answers, and it answers it from
   * `MergeFieldDecision.fromRowLocatorId`, which is still recorded, on the
   * merges, where a reader looks for it. The copy on the value was the same
   * fact repeated once per field of every record in the run, merged or not, and
   * it was spilled with the record every time the record was spilled.
   */
}

/**
 * The identity of an opinion about a field, for deciding whether the rows of a
 * record agree.
 *
 * A clear is its own opinion and can never collide with a value, so the two are
 * tagged apart rather than both reduced to an absent string.
 */
function opinionKey(intent: ValueIntent): string {
  return intent.kind === 'CLEAR' ? 'CLEAR' : `VALUE:${String(intendedValue(intent))}`;
}

/**
 * A row that went into a record, described rather than carried.
 *
 * A resolved record used to hold the drafts it was built from, and a draft
 * holds every value it produced with the column and the address each came
 * from. Holding them meant the whole source stayed in memory for as long as
 * the records did: at 250,000 rows the drafts alone were most of what the run
 * carried.
 *
 * The values a record delivers are in `values`, merged. What is left is what
 * anything downstream actually asks a member for -- where the row was, what it
 * called itself, and the identity key it held -- so that is what a member is.
 */
export interface RecordMember {
  readonly address: RowAddress;
  readonly recordMappingId: string;
  readonly object: CanonicalObject;
  readonly sourceSystem: string;
  readonly sourceNamespace: string;
  readonly sourceRecordId: string | null;
  /** The first proving key this row held, or null if it held none. */
  readonly identityKey: string | null;
  /** The scope inside which `sourceRecordId` means something. */
  readonly identitySpace: string;
  /**
   * What this row said, for each signal duplicate detection looks at.
   *
   * Per member, not per record, because a merge that has already happened
   * would otherwise hide the value one of its rows carried -- which is the
   * whole reason the check reads members. Three short strings, rather than
   * every value the row produced.
   */
  readonly signals: ReadonlyMap<string, string>;
}

function memberOf(draft: DraftRecord): RecordMember {
  const signals = new Map<string, string>();
  for (const signal of SIGNALS) {
    const value = signal.extract(draft.values);
    if (value !== null) signals.set(signal.kind, value);
  }
  return {
    address: draft.address,
    recordMappingId: draft.recordMappingId,
    object: draft.object,
    sourceSystem: draft.sourceSystem,
    sourceNamespace: draft.sourceNamespace,
    sourceRecordId: draft.sourceRecordId,
    identityKey: draft.identityKeys[0]?.key ?? null,
    identitySpace: draft.identitySpace,
    signals,
  };
}

export interface ResolvedRecord {
  readonly migrationKey: string;
  /**
   * The identity key `migrationKey` is derived from: the lexicographically
   * smallest key held by any row of this record, or null when the record has no
   * proving key and the migration key comes from the row address instead.
   *
   * It is carried so a package can be checked without the run that produced it.
   * Without it the migration key is an assertion nothing in the package can
   * recompute, and a forged merge that copies one row's key onto another goes
   * unnoticed.
   */
  readonly canonicalIdentityKey: string | null;
  readonly object: CanonicalObject;
  readonly recordMappingId: string;
  readonly survivor: RecordMember;
  readonly members: readonly RecordMember[];
  readonly values: ReadonlyMap<string, ResolvedValue>;
  readonly mergeId: string | null;
  readonly isolation: {
    readonly reasonCode: ReasonCode;
    readonly detail: string;
    readonly field?: string | null;
  } | null;
}

export interface IdentityResult {
  /**
   * The records, in migration-key order, read back from where they were
   * written rather than held.
   *
   * One record per delivered record is one per source row in the ordinary
   * case, and each carries every value it delivers. Held as an array they were
   * the largest thing the run carried once the drafts had gone.
   */
  readonly records: SpooledFamily<ResolvedRecord>;
  readonly merges: readonly MergeRecord[];
  /**
   * The duplicate candidates, spilled like every other row-scale family, and the
   * two counts the reconciliation needs taken where they were produced.
   *
   * They were an array, copied again by `sorted()`, and the reconciliation then
   * built a `Set` of every cluster id and another of every row locator over it.
   * On a source that collides with itself -- ten sheets carrying the same ids --
   * that is four structures the size of the table, live at once.
   */
  readonly duplicateCandidates: SpooledFamily<DuplicateCandidateEntry>;
  readonly duplicateCandidateClusters: number;
  readonly duplicateCandidateRows: number;
}

/**
 * The order the rows of a record are compared in: where the row came from.
 *
 * Applied by the key the group is spilled under rather than by sorting the
 * group after the fact, so the members arrive in this order and a group is
 * never rearranged in memory.
 */

/**
 * Identity resolution.
 *
 * Records are combined only when they share a key the configuration declares
 * authoritative: a source CRM record id within one source system and namespace,
 * or a column marked as an authoritative external identifier. Everything else —
 * a shared email address, a shared phone number, the same name — produces a
 * duplicate candidate for review and changes nothing.
 */
export function resolveIdentity(
  drafts: SpooledFamily<DraftRecord>,
  policies: Policies,
  bundleId: string,
  scratch: ScratchStore,
  /**
   * The largest set of rows that may resolve to one identity, or share one
   * duplicate signal.
   *
   * A parameter with the declared constant as its default, and the default is
   * what every caller uses. It is a parameter only so the refusal can be
   * exercised: a test that had to build a quarter of a million rows to reach it
   * is a test nobody runs, and a limit whose refusal has never fired is a limit
   * nobody has checked.
   */
  maxGroupMembers: number = MAX_IDENTITY_GROUP_MEMBERS,
): IdentityResult {
  // Written down in migration-key order as each group resolves, and read back
  // in that order by everything downstream.
  const recordsOut = openFamily<ResolvedRecord>(scratch, {
    schema: 'records',
    key: (record) => record.migrationKey,
    encode: encodeRecord,
    decode: decodeRecord,
  });
  const merges: MergeRecord[] = [];

  for (const group of groupByProvingKeys(drafts, scratch, maxGroupMembers)) {
    const members = group;
    const survivor = members[0];
    if (survivor === undefined) {
      throw new CoreInvariantError('IDENTITY_GROUP_NON_EMPTY', 'an identity group contained no rows');
    }

    const byKey = new Map<string, ProvingKey>();
    const holders = new Map<string, number>();
    // The spellings the source used for each key, where the plan declared an
    // identity normalization. More than one spelling under one key is a
    // collision the normalization made, and the merge has to say so.
    const spellings = new Map<string, Set<string>>();
    for (const member of members) {
      const own = new Set<string>();
      for (const item of member.identityKeys) {
        if (item.sourceValue !== undefined) {
          const held = spellings.get(item.key) ?? new Set<string>();
          held.add(item.sourceValue);
          spellings.set(item.key, held);
        }
        if (!byKey.has(item.key)) byKey.set(item.key, item);
        if (!own.has(item.key)) {
          own.add(item.key);
          holders.set(item.key, (holders.get(item.key) ?? 0) + 1);
        }
      }
    }
    const allKeys = sorted([...byKey.values()], by(onString((item) => item.key)));
    const canonicalKey = allKeys[0]?.key ?? null;
    const migrationKey =
      canonicalKey === null
        ? migrationKeyFromRow(
            survivor.object,
            survivor.sourceSystem,
            survivor.sourceNamespace,
            bundleId,
            survivor.address.rowLocatorId,
          )
        : migrationKeyFromIdentity(survivor.object, canonicalKey);

    const merged = mergeValues(members, survivor, policies);

    const draftIsolation = members.map((member) => member.isolation).find((item) => item !== null) ?? null;
    const isolation = merged.isolation ?? draftIsolation;

    const mergeId = members.length > 1 ? mergeIdFor(allKeys.map((item) => item.key)) : null;
    const evidence = describeEvidence(allKeys, holders, spellings);

    recordsOut.add({
      migrationKey,
      canonicalIdentityKey: canonicalKey,
      object: survivor.object,
      recordMappingId: survivor.recordMappingId,
      survivor: memberOf(survivor),
      members: members.map(memberOf),
      values: merged.values,
      mergeId,
      isolation,
    });

    if (mergeId !== null) {
      // The authority table is the gate, so it is called rather than described.
      // A group only exists because two rows shared a key, so this holds by
      // construction; it fails loudly if grouping and evidence ever disagree.
      if (!permitsAutomaticMerge(evidence)) {
        throw new CoreInvariantError(
          'IDENTITY_MERGE_REQUIRES_PROVING_EVIDENCE',
          `merge ${mergeId} cites no key held by more than one of its ${String(members.length)} rows`,
        );
      }
      merges.push({
        mergeId,
        object: survivor.object,
        survivorMigrationKey: migrationKey,
        survivorRowLocatorId: survivor.address.rowLocatorId,
        absorbedRowLocatorIds: members.slice(1).map((member) => member.address.rowLocatorId),
        identityEvidence: evidence,
        fieldDecisions: merged.decisions,
        conflicts: merged.conflicts,
        associationRemaps: [],
        ruleVersion: IDENTITY_RULE_VERSION,
      });
    }
  }

  const ordered = recordsOut.seal();
  const candidates = findDuplicateCandidates(ordered, scratch, maxGroupMembers);
  return {
    records: ordered,
    merges: sorted(merges, by(onString((merge) => merge.mergeId))),
    duplicateCandidates: candidates.entries,
    duplicateCandidateClusters: candidates.clusters,
    duplicateCandidateRows: candidates.rows,
  };
}

// ------------------------------------------------------------------ grouping

/**
 * The rows that describe one record, without holding the rows.
 *
 * Two rows belong to the same record when they share a proving key, and
 * sharing is transitive: A shares a key with B, B with C, so all three are one
 * record. That is a connected component, and finding components used to mean
 * holding every draft in memory and a map from every key to a row.
 *
 * It is done in three passes over spilled data instead:
 *
   1. every (key, row) pair is spilled and read back in key order, so the rows
      that share a key arrive next to each other and each pair is united with
      the one before it;
 *
   2. the drafts are re-spilled under the component each row ended up in, and
      within a component in the order the members are compared in;
 *
   3. the groups are handed out one at a time as that family is walked.
 *
 * What is held is the union-find itself -- four bytes per row -- and one
 * group. A component larger than memory is still a component larger than
 * memory, and the canonical document says so: it is a limit to declare, not a
 * structure to grow.
 */
function* groupByProvingKeys(
  drafts: SpooledFamily<DraftRecord>,
  scratch: ScratchStore,
  maxGroupMembers: number,
): IterableIterator<DraftRecord[]> {
  const count = drafts.count;
  const parent = new Int32Array(count);
  for (let index = 0; index < count; index += 1) parent[index] = index;

  const find = (node: number): number => {
    let current = node;
    while (parent[current] !== current) {
      const next = parent[current] as number;
      parent[current] = parent[next] as number;
      current = parent[current] as number;
    }
    return current;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // The smaller index wins, so the component is named by its earliest row
    // and the naming does not depend on the order the keys were read.
    parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  const holders = openFamily<{ key: string; row: number }>(scratch, {
    schema: 'identity-key-holders',
    key: (entry) => orderKey(orderText(entry.key), orderNumber(entry.row)),
  });
  let index = 0;
  for (const draft of drafts) {
    for (const item of draft.identityKeys) holders.add({ key: item.key, row: index });
    index += 1;
  }
  let previousKey: string | null = null;
  let previousRow = -1;
  const heldKeys = holders.seal();
  for (const entry of heldKeys) {
    if (previousKey === entry.key) union(previousRow, entry.row);
    previousKey = entry.key;
    previousRow = entry.row;
  }
  // Spent. The one thing this family exists for is the walk above: it puts the
  // rows that share a key next to each other so the union-find can join them,
  // and once every adjacent pair has been united the answer lives in the
  // union-find, which is four bytes a row. Nothing below reads a key holder
  // again.
  heldKeys.release();

  const grouped = openFamily<{ root: number; draft: DraftRecord }>(scratch, {
    schema: 'identity-groups',
    key: (entry) =>
      orderKey(
        orderNumber(entry.root),
        entry.draft.address.filePath,
        entry.draft.address.sheetId,
        orderNumber(entry.draft.address.rowNumberSource),
      ),
    encode: encodeDraft,
    decode: decodeDraft,
  });
  index = 0;
  for (const draft of drafts) {
    grouped.add({ root: find(index), draft });
    index += 1;
  }

  let current: DraftRecord[] = [];
  let currentRoot = -1;
  const heldGroups = grouped.seal();
  for (const entry of heldGroups) {
    if (entry.root !== currentRoot && current.length > 0) {
      yield current;
      current = [];
    }
    currentRoot = entry.root;
    current.push(entry.draft);
    // The declared limit, enforced.
    //
    // The comment at the head of this function has always said that a component
    // larger than memory is a limit to declare rather than a structure to grow.
    // Nothing declared it and nothing enforced it, so what the run did with one
    // was exhaust the heap — after however long it took to get there, with a
    // trace naming an allocation rather than a column.
    if (current.length > maxGroupMembers) {
      throw new MigrationError(
        'IDENTITY_GROUP_TOO_LARGE',
        `more than ${String(maxGroupMembers)} rows resolve to a single identity`,
        'A group this size is not a merge; it is a proving key that does not identify anybody — a column whose unassigned ' +
          'rows carry 0, UNKNOWN, TBD or a placeholder, matched as though each were a real external id. Remove that column ' +
          'from the identity configuration, or exclude the placeholder, and run again.',
        { limit: maxGroupMembers, membersSoFar: current.length },
      );
    }
  }
  if (current.length > 0) yield current;

  // Spent, and this is the last reader: the groups were written so that the
  // rows of one record arrive together, and the loop above has handed out every
  // one of them. Released here rather than by the caller because the caller
  // never sees this family -- it sees the groups, one at a time.
  //
  // A consumer that abandons the iteration early never reaches this, and that
  // is correct rather than a leak: the run is failing, and the store's own
  // dispose removes everything the run wrote.
  heldGroups.release();
}

/**
 * A draft, written down and read back.
 *
 * Its values are a `Map`, which JSON writes as `{}`. Spilling a draft through
 * the default encoding would therefore return a record with no values at all --
 * a silent loss rather than a failure -- so the pairs are written explicitly.
 */
function encodeDraft(entry: { root: number; draft: DraftRecord }): string {
  return JSON.stringify({
    root: entry.root,
    draft: { ...entry.draft, values: [...entry.draft.values] },
  });
}

function decodeDraft(line: string): { root: number; draft: DraftRecord } {
  const raw = JSON.parse(line) as {
    root: number;
    draft: Omit<DraftRecord, 'values'> & { values: [string, DraftValue][] };
  };
  return { root: raw.root, draft: { ...raw.draft, values: new Map(raw.draft.values) } };
}

/**
 * The kind is carried structurally rather than recovered by inspecting the key
 * text, and the authority is decided per cited key rather than per kind: a key
 * only one row of the merge holds did not join anything, whatever kind it is.
 */
function describeEvidence(
  keys: readonly ProvingKey[],
  holders: ReadonlyMap<string, number>,
  spellings: ReadonlyMap<string, ReadonlySet<string>>,
): IdentityEvidence[] {
  return keys.map((item) => {
    const heldByMembers = holders.get(item.key) ?? 1;
    const joined = heldByMembers > 1;
    const written = [...(spellings.get(item.key) ?? [])].sort(compareCodeUnits);
    // Several spellings under one key: the merge exists because the plan's
    // identity normalization made them equal, not because the source did.
    const collided = joined && written.length > 1;
    return {
      kind: item.kind,
      authority: joined ? ('PROVING' as const) : ('SUPPORTING' as const),
      heldByMembers,
      value: item.key,
      reasonCode: collided
        ? ('IDENTITY_NORMALIZATION_COLLISION' as const)
        : joined
          ? item.kind === 'AUTHORITATIVE_EXTERNAL_ID'
            ? ('IDENTITY_PROVEN_EXTERNAL_ID' as const)
            : ('IDENTITY_PROVEN_SOURCE_RECORD_ID' as const)
          : ('IDENTITY_MEMBER_KEY_NOT_SHARED' as const),
      ...(collided ? { sourceValues: written } : {}),
    };
  });
}

// -------------------------------------------------------------------- merge

interface MergeOutcome {
  readonly values: ReadonlyMap<string, ResolvedValue>;
  readonly decisions: readonly MergeFieldDecision[];
  readonly conflicts: readonly MergeConflict[];
  readonly isolation: {
    readonly reasonCode: ReasonCode;
    readonly detail: string;
    readonly field?: string | null;
  } | null;
}

function mergeValues(
  members: readonly DraftRecord[],
  survivor: DraftRecord,
  policies: Policies,
): MergeOutcome {
  const values = new Map<string, ResolvedValue>();
  const decisions: MergeFieldDecision[] = [];
  const conflicts: MergeConflict[] = [];
  let isolation: { reasonCode: ReasonCode; detail: string } | null = null;

  const fields = sorted(
    [...new Set(members.flatMap((member) => [...member.values.keys()]))],
    compareCodeUnits,
  );

  for (const fieldName of fields) {
    // A row that asks for the field to be cleared has said something about it.
    // Reading only the populated rows treated a clear as silence, so a merge
    // could deliver another row's value over a clear the plan authorized and
    // record nothing about having done so.
    const opinions = members
      .map((member) => ({ member, intent: member.values.get(fieldName)?.intent ?? omit('NO_VALUE_PRODUCED') }))
      .filter((entry) => entry.intent.kind !== 'OMIT');
    const populated = opinions
      .map((entry) => ({ member: entry.member, value: intendedValue(entry.intent) }))
      .filter((entry): entry is { member: DraftRecord; value: string } => entry.value !== null);

    const distinct = sorted([...new Set(opinions.map((entry) => opinionKey(entry.intent)))], compareCodeUnits);
    const survivorIntent = survivor.values.get(fieldName)?.intent ?? omit('NO_VALUE_PRODUCED');
    const survivorValue = intendedValue(survivorIntent);

    if (distinct.length === 0) {
      values.set(fieldName, { intent: survivorIntent });
      continue;
    }

    if (distinct.length === 1) {
      const only = opinions[0];
      if (only === undefined) {
        throw new CoreInvariantError('MERGE_POPULATED_NON_EMPTY', 'a populated field list was unexpectedly empty');
      }
      values.set(fieldName, { intent: only.intent });
      if (only.intent.kind !== 'CLEAR' && members.length > 1 && (survivorValue === null || survivorValue.length === 0)) {
        decisions.push({
          destinationField: fieldName,
          value: intendedValue(only.intent),
          fromRowLocatorId: only.member.address.rowLocatorId,
          reasonCode: 'IDENTITY_MERGE_FIELD_FILLED_FROM_ABSORBED_ROW',
        });
      }
      continue;
    }

    // One row wants the field emptied and another wants it filled. There is no
    // safe automatic answer to that, and choosing the value would be the
    // destruction rule read backwards, so the record is set aside whatever the
    // conflict policy says — exactly as a consent conflict is.
    const clearing = opinions.filter((entry) => entry.intent.kind === 'CLEAR');
    if (clearing.length > 0) {
      conflicts.push({
        destinationField: fieldName,
        semanticsClass:
          members
            .map((member) => member.values.get(fieldName)?.semanticsClass ?? 'STANDARD')
            .find((value) => value === 'CONSENT') ?? 'STANDARD',
        values: populated.map((entry) => ({
          rowLocatorId: entry.member.address.rowLocatorId,
          value: entry.value,
        })),
        reasonCode: 'IDENTITY_MERGE_CLEAR_CONFLICT',
      });
      values.set(fieldName, { intent: survivorIntent });
      if (isolation === null) {
        isolation = {
          reasonCode: 'ISOLATED_IDENTITY_CONFLICT',
          detail: `rows proven to be one record disagree on "${fieldName}": ${listBounded(
            clearing.map((entry) => entry.member.address.rowLocatorId),
          )} authorize clearing it while others carry a value`,
        };
      }
      continue;
    }

    const semanticsClass =
      members
        .map((member) => member.values.get(fieldName)?.semanticsClass ?? 'STANDARD')
        .find((value) => value === 'CONSENT') ?? 'STANDARD';
    const reasonCode: ReasonCode =
      semanticsClass === 'CONSENT' ? 'IDENTITY_MERGE_CONSENT_CONFLICT' : 'IDENTITY_MERGE_FIELD_CONFLICT';

    conflicts.push({
      destinationField: fieldName,
      semanticsClass,
      values: populated.map((entry) => ({
        rowLocatorId: entry.member.address.rowLocatorId,
        value: entry.value,
      })),
      reasonCode,
    });

    // Consent conflicts are never resolved automatically, whatever the policy says.
    const resolveBySurvivor = policies.mergeFieldConflict === 'PREFER_SURVIVOR' && semanticsClass !== 'CONSENT';

    if (resolveBySurvivor && survivorValue !== null && survivorValue.length > 0) {
      values.set(fieldName, { intent: survivorIntent });
      decisions.push({
        destinationField: fieldName,
        value: survivorValue,
        fromRowLocatorId: survivor.address.rowLocatorId,
        reasonCode,
      });
      continue;
    }

    values.set(fieldName, { intent: survivorIntent });
    if (isolation === null) {
      isolation = {
        reasonCode: 'ISOLATED_IDENTITY_CONFLICT',
        // The values, not the keys the agreement test compares. Opinion keys
        // are an internal tag and have no business in a sentence somebody reads.
        detail: describeConflict(
          fieldName,
          populated.map((entry) => entry.value),
        ),
      };
    }
  }

  return { values, decisions, conflicts, isolation };
}

/** How many distinct conflicting values a record's isolation sentence names. */
export const CONFLICT_DETAIL_MAX_VALUES = 5;
/** How many characters of one conflicting value the sentence quotes. */
export const CONFLICT_DETAIL_MAX_VALUE_CHARS = 80;

/** The first few of a set of row locators, in code-unit order, and a count of the rest. */
function listBounded(items: readonly string[]): string {
  const ordered = sorted([...items], compareCodeUnits);
  const rest = ordered.length - CONFLICT_DETAIL_MAX_VALUES;
  return `${ordered.slice(0, CONFLICT_DETAIL_MAX_VALUES).join(', ')}${rest > 0 ? ` and ${String(rest)} more` : ''}`;
}

/**
 * The sentence saying which field disagreed and how. It is bounded (B01-R7):
 * a record of n rows with n distinct values used to carry an n-value sentence,
 * and the sentence was copied into the entry of every member row, so what the
 * run spilled grew with n squared. The sentence now names the first few values
 * in code-unit order and counts the rest. The complete set of values stays in
 * the conflicts the record reports, once.
 */
export function describeConflict(fieldName: string, values: readonly string[]): string {
  const distinct = sorted([...new Set(values)], compareCodeUnits);
  const quote = (value: string): string => {
    const points = Array.from(value.slice(0, CONFLICT_DETAIL_MAX_VALUE_CHARS * 2));
    const clipped = value.length > CONFLICT_DETAIL_MAX_VALUE_CHARS || points.length > CONFLICT_DETAIL_MAX_VALUE_CHARS;
    return `"${points.slice(0, CONFLICT_DETAIL_MAX_VALUE_CHARS).join('')}${clipped ? '…' : ''}"`;
  };
  const named = distinct.slice(0, CONFLICT_DETAIL_MAX_VALUES).map(quote).join(' vs ');
  const rest = distinct.length - CONFLICT_DETAIL_MAX_VALUES;
  return `rows proven to be one record disagree on "${fieldName}": ${named}${rest > 0 ? ` and ${String(rest)} more` : ''}`;
}

// --------------------------------------------------------- duplicate review

interface Signal {
  readonly kind: string;
  readonly reasonCode: ReasonCode;
  readonly describe: string;
  /** Reads one member row, so no value is hidden by a merge that already happened. */
  readonly extract: (values: ReadonlyMap<string, { intent: ValueIntent }>) => string | null;
}

function memberSignalValues(record: ResolvedRecord, signal: Signal): string[] {
  const found = new Set<string>();
  for (const member of record.members) {
    const value = member.signals.get(signal.kind);
    if (value !== undefined) found.add(value);
  }
  return [...found];
}

const SIGNALS: readonly Signal[] = [
  {
    kind: 'EMAIL_EXACT',
    reasonCode: 'IDENTITY_CANDIDATE_EMAIL_EXACT',
    describe: 'the records share an email address',
    extract: (values) => nonEmpty(carried(values.get('contact.email'))),
  },
  {
    kind: 'PHONE_E164',
    reasonCode: 'IDENTITY_CANDIDATE_PHONE_E164',
    describe: 'the records share a phone number in international form',
    extract: (values) => {
      const value = nonEmpty(carried(values.get('contact.phone')));
      return value !== null && value.startsWith('+') ? value : null;
    },
  },
  {
    kind: 'NAME_EXACT',
    reasonCode: 'IDENTITY_CANDIDATE_NAME_EXACT',
    describe: 'the records share a full name',
    extract: (values) => {
      const first = nonEmpty(carried(values.get('contact.firstName')));
      const last = nonEmpty(carried(values.get('contact.lastName')));
      if (first === null || last === null) return null;
      return `${first.toLowerCase()} ${last.toLowerCase()}`;
    },
  },
  {
    kind: 'COMPANY_DOMAIN',
    reasonCode: 'IDENTITY_CANDIDATE_COMPANY_DOMAIN',
    describe: 'the records share a company web domain',
    extract: (values) => {
      const value = nonEmpty(carried(values.get('company.domain')));
      return value === null ? null : value.toLowerCase();
    },
  },
];

/**
 * Records that look like the same person or company and were not merged.
 *
 * Grouped through scratch rather than through a map of every record: each
 * record is written once per signal it carries, read back in signal order so
 * the records sharing a signal arrive together, and only a cluster is held.
 * A cluster is bounded by how many records share one email or one phone
 * number, which is the thing being reported.
 */
/**
 * What a duplicate cluster needs to know about a record, and nothing else.
 *
 * The duplicate families used to spill the whole `ResolvedRecord` under each
 * bucket, through the record codec, once per signal the record carries. Six
 * families did it, and together they were 20.5% of everything the run spilled
 * -- 'duplicate-source-record-id' alone was as large as the records family it
 * was copying, because every record holds a source record id.
 *
 * Nothing after the grouping reads a record. The cluster reports the migration
 * key, the object, where the survivor row was, and what differs between the
 * records; the cross-namespace check also reads the survivor's source system,
 * namespace and identity space. The members, their addresses, their signal maps
 * and the intent wrappers on the values are all read *before* the spill, where
 * the bucket is chosen and the whole record is in hand, so none of them has to
 * survive the write.
 *
 * `values` holds only the fields that carry a value, as the value itself.
 * `describeConflicts` is the only reader, and it discards a field no record in
 * the cluster carries a non-empty value for -- so a field that was going to be
 * dropped on the way out is not written down on the way in.
 */
interface DuplicateSubject {
  readonly object: CanonicalObject;
  readonly migrationKey: string;
  readonly rowLocatorId: string;
  readonly filePath: string;
  readonly rowNumberSource: number;
  readonly sourceSystem: string;
  readonly sourceNamespace: string;
  readonly identitySpace: string;
  readonly values: Record<string, string>;
}

function subjectOf(record: ResolvedRecord): DuplicateSubject {
  const values: Record<string, string> = {};
  for (const [fieldName, resolved] of record.values) {
    const value = intendedValue(resolved.intent);
    if (value !== null && value.length > 0) values[fieldName] = value;
  }
  return {
    object: record.object,
    migrationKey: record.migrationKey,
    rowLocatorId: record.survivor.address.rowLocatorId,
    filePath: record.survivor.address.filePath,
    rowNumberSource: record.survivor.address.rowNumberSource,
    sourceSystem: record.survivor.sourceSystem,
    sourceNamespace: record.survivor.sourceNamespace,
    identitySpace: record.survivor.identitySpace,
    values,
  };
}

/**
 * The records sharing each value, one cluster at a time.
 *
 * The family arrives in bucket order, so a cluster is the run of entries with
 * the same bucket, and only that run is held. A record that carries the same
 * value twice appears once: the family is keyed by bucket and migration key,
 * so its repeats are adjacent.
 */
/**
 * A resolved record, written down and read back.
 *
 * Two of its parts are `Map`s -- the values it delivers, and the signals each
 * of its members carried -- and JSON writes a `Map` as `{}`. Spilling through
 * the default encoding would return a record that delivers nothing, which is a
 * silent loss rather than a failure, so the pairs are written explicitly.
 */
export function recordToJson(record: ResolvedRecord): unknown {
  // The survivor is not written down, because it is already there.
  //
  // A record's survivor is its first member -- `resolveIdentity` takes both
  // from the same group, in the same order -- so writing `survivor` as well as
  // `members` put the same member in the segment twice, and a member carries a
  // full row address (two SHA-256 digests among the rest) and a signal map. It
  // was the largest single duplication inside a spilled record.
  //
  // Checked rather than assumed, on the way out, where a mismatch can still be
  // named: one row is one member, so comparing the locator is comparing the
  // members.
  const first = record.members[0];
  if (first === undefined || first.address.rowLocatorId !== record.survivor.address.rowLocatorId) {
    throw new CoreInvariantError(
      'RECORD_SURVIVOR_IS_FIRST_MEMBER',
      'a resolved record was written whose survivor is not its first member',
      {
        migrationKey: record.migrationKey,
        survivorRowLocatorId: record.survivor.address.rowLocatorId,
        firstMemberRowLocatorId: first?.address.rowLocatorId ?? null,
      },
    );
  }
  // Written field by field rather than by spreading the record and deleting
  // one: the fields that are spilled are then stated here rather than inferred
  // from what the type happens to hold, and `recordFromJson` below is the only
  // thing that has to agree with this list.
  return {
    migrationKey: record.migrationKey,
    canonicalIdentityKey: record.canonicalIdentityKey,
    object: record.object,
    recordMappingId: record.recordMappingId,
    mergeId: record.mergeId,
    isolation: record.isolation,
    values: [...record.values],
    members: record.members.map((member) => ({ ...member, signals: [...member.signals] })),
  };
}

export function recordFromJson(raw: unknown): ResolvedRecord {
  const held = raw as Omit<ResolvedRecord, "values" | "survivor" | "members"> & {
    values: [string, ResolvedValue][];
    members: (Omit<RecordMember, "signals"> & { signals: [string, string][] })[];
  };
  const members = held.members.map((member) => ({ ...member, signals: new Map(member.signals) }));
  const survivor = members[0];
  if (survivor === undefined) {
    throw new CoreInvariantError(
      'RECORD_HAS_MEMBERS',
      'a resolved record was read back with no member rows',
      { migrationKey: held.migrationKey },
    );
  }
  return {
    ...held,
    values: new Map(held.values),
    survivor,
    members,
  };
}

function encodeRecord(record: ResolvedRecord): string {
  return JSON.stringify(recordToJson(record));
}

function decodeRecord(line: string): ResolvedRecord {
  return recordFromJson(JSON.parse(line));
}
function* clustersOf(
  shared: SpooledFamily<{ bucket: string; subject: DuplicateSubject }>,
  maxGroupMembers: number,
): IterableIterator<[string, DuplicateSubject[]]> {
  let bucket: string | null = null;
  let held: DuplicateSubject[] = [];
  let previousKey: string | null = null;
  for (const entry of shared) {
    if (entry.bucket !== bucket) {
      if (bucket !== null && held.length > 0) yield [bucket, held];
      bucket = entry.bucket;
      held = [];
      previousKey = null;
    }
    if (previousKey === entry.subject.migrationKey) continue;
    previousKey = entry.subject.migrationKey;
    held.push(entry.subject);
    // The same declared limit. A duplicate cluster holds every member's whole
    // delivered value set, so it is the heavier of the two per member — and it
    // needs no configuration to reach: one shared mailbox on four hundred
    // thousand web-form leads is one bucket.
    if (held.length > maxGroupMembers) {
      throw new MigrationError(
        'IDENTITY_GROUP_TOO_LARGE',
        `more than ${String(maxGroupMembers)} records share one duplicate signal`,
        'A signal that groups this many records is not identifying — a shared mailbox, a switchboard number, a repeated ' +
          'placeholder name. Exclude that value, or narrow the signal, and run again.',
        { limit: maxGroupMembers, membersSoFar: held.length },
      );
    }
  }
  if (bucket !== null && held.length > 0) yield [bucket, held];
}
/**
 * The duplicate candidates, and the two counts the reconciliation needs.
 *
 * A family rather than an array, and the counts taken here rather than by
 * walking one afterwards. Both halves of that are the same decision made twice.
 *
 * The array held one object of fourteen fields per record per signal it shares
 * with another record, and then `sorted()` copied the whole of it. On the
 * SHEET_COUNT profile, whose ten mapped sheets carry the same source ids, that
 * is one entry per record and the copy is a second — and the reconciliation then
 * built two more `Set`s over it, one of every cluster id and one of every row
 * locator. Four structures proportional to how much the customer's data collides
 * with itself, all live at once, in the middle of the run.
 *
 * The family gives the same order through the external sort that every other
 * row-scale artifact already goes through, so nothing downstream changes. The
 * counts are taken where the entries are produced, which is what
 * `edgeCandidateCount` already does and for the reason stated there: a tally
 * taken by walking the thing it is meant to check is an identity, not a check.
 */
interface DuplicateCandidates {
  readonly entries: SpooledFamily<DuplicateCandidateEntry>;
  readonly clusters: number;
  readonly rows: number;
}

function findDuplicateCandidates(
  records: SpooledFamily<ResolvedRecord>,
  scratch: ScratchStore,
  maxGroupMembers: number,
): DuplicateCandidates {
  const out = openFamily<DuplicateCandidateEntry>(scratch, {
    schema: 'duplicate-candidates',
    key: (entry) => orderKey(orderText(entry.clusterId), entry.migrationKey),
  });
  // Every row locator an entry names, so the distinct count can be taken by
  // reading them back in order rather than by holding a set of them.
  const locators = openFamily<{ rowLocatorId: string }>(scratch, {
    schema: 'duplicate-candidate-rows',
    key: (entry) => orderText(entry.rowLocatorId),
  });
  let clusters = 0;
  const emit = (entry: DuplicateCandidateEntry): void => {
    out.add(entry);
    locators.add({ rowLocatorId: entry.rowLocatorId });
  };

  for (const signal of SIGNALS) {
    // One entry per record per value it carries for this signal, read back in
    // signal order so the records that share a value arrive next to each other.
    // The subject, not the record. The signal values are extracted from the
    // members here, where the record is still in hand, so what is written down
    // is what the cluster reports rather than what it was derived from.
    const shared = openFamily<{ bucket: string; subject: DuplicateSubject }>(scratch, {
      schema: `duplicate-signal-${signal.kind.toLowerCase()}`,
      key: (entry) => orderKey(orderText(entry.bucket), entry.subject.migrationKey),
    });
    for (const record of records) {
      const values = memberSignalValues(record, signal);
      if (values.length === 0) continue;
      const subject = subjectOf(record);
      for (const value of values) {
        shared.add({ bucket: `${record.object}|${value}`, subject });
      }
    }

    for (const [key, bucket] of clustersOf(shared.seal(), maxGroupMembers)) {
      if (bucket.length < 2) continue;
      const value = key.slice(key.indexOf('|') + 1);
      const clusterId = clusterIdFor(signal.kind, value, bucket.map((subject) => subject.migrationKey));
      const conflicts = describeConflicts(bucket);
      const notMerged: ReasonCode =
        conflicts.length > 0
          ? 'IDENTITY_CANDIDATE_CONFLICTING_ATTRIBUTES'
          : 'IDENTITY_DISTINCT_NO_PROVING_EVIDENCE';
      clusters += 1;
      for (const record of bucket) {
        emit({
          clusterId,
          object: record.object,
          migrationKey: record.migrationKey,
          rowLocatorId: record.rowLocatorId,
          filePath: record.filePath,
          rowNumberSource: record.rowNumberSource,
          signal: signal.kind,
          signalValue: value,
          evidence: signal.describe,
          conflicts,
          whyNotMerged:
            'The records share a signal but no authoritative identifier proves they are the same record, so they were kept separate.',
          reasonCode: signal.reasonCode,
          notMergedReasonCode: notMerged,
        });
      }
    }
  }

  // Appended one at a time, not spread.
  //
  // This was `entries.push(...findCrossNamespaceCollisions(records, scratch))`,
  // and the spread is not a style question: every element of the array becomes
  // an *argument*, and V8 refuses a call past roughly 125,000 of them. The array
  // here is one entry per colliding record, so it grows with the source, and the
  // engine died with `RangeError: Maximum call stack size exceeded` on the
  // SHEET_COUNT capacity profile at 150,024 rows -- at 867 MB of resident
  // memory, nowhere near any budget, which is why it read as an out-of-memory
  // failure for a day and was not one.
  //
  // The rung below it passed at about 100,000 collisions, just under the limit.
  // So this had nothing to do with the workbook reader it was blamed on, and no
  // amount of bounding the reader would have moved it.
  // The cross-namespace collisions, written into the same family. They used to
  // come back as a second array and be appended one at a time -- which was
  // itself a fix, for a spread that made every element a call argument and blew
  // the stack at about 125,000 of them. Writing them where they are produced
  // removes the array and the appending together.
  clusters += emitCrossNamespaceCollisions(records, scratch, emit, maxGroupMembers);

  const entries = out.seal();

  // Distinct row locators, counted by reading the spilled locators back in
  // order. A row may appear under several signals and again among the
  // collisions, so distinctness is real work; what it must not be is a set of
  // every row in the table.
  let rows = 0;
  let previous: string | null = null;
  for (const entry of locators.seal()) {
    if (entry.rowLocatorId === previous) continue;
    previous = entry.rowLocatorId;
    rows += 1;
  }

  return { entries, clusters, rows };
}

/**
 * The same raw record id appearing twice: under two source systems or
 * namespaces, or in two identity spaces of one source. Neither is proof of
 * anything, and neither is silence. The entry exists so a reviewer can see the
 * engine noticed the coincidence and deliberately did not act on it.
 */
function emitCrossNamespaceCollisions(
  records: SpooledFamily<ResolvedRecord>,
  scratch: ScratchStore,
  emit: (entry: DuplicateCandidateEntry) => void,
  maxGroupMembers: number,
): number {
  let clusters = 0;
  // Every member's raw id, not just the survivor's: reading the survivor alone
  // let a merge erase the evidence of a collision, which is the one thing the
  // contract says duplicate signals must not do.
  //
  // Grouped through scratch, like the signal clusters: one entry per record
  // per raw id it holds, read back in id order so the records that share one
  // arrive together.
  //
  // The subject, not the record: every member's raw id is read here, where the
  // members are still in hand, and what is written down is what the cluster
  // reports. This family was the single largest of the duplicate six, because
  // every record with a source record id was copied whole into it.
  const shared = openFamily<{ bucket: string; subject: DuplicateSubject }>(scratch, {
    schema: 'duplicate-source-record-id',
    key: (entry) => orderKey(orderText(entry.bucket), entry.subject.migrationKey),
  });
  for (const record of records) {
    const seen = new Set<string>();
    let subject: DuplicateSubject | null = null;
    for (const member of record.members) {
      const id = member.sourceRecordId;
      if (id === null) continue;
      const key = `${record.object}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subject ??= subjectOf(record);
      shared.add({ bucket: key, subject });
    }
  }

  for (const [key, bucket] of clustersOf(shared.seal(), maxGroupMembers)) {
    if (bucket.length < 2) continue;
    const namespaces = new Set(
      bucket.map((record) => `${record.sourceSystem}/${record.sourceNamespace}`),
    );
    const spaces = new Set(bucket.map((record) => record.identitySpace));
    // Two different reasons the same raw id can appear twice, and both have to
    // be reported. The identity-space case is the one the space default
    // creates: splitting the id sequences is right, but shipping one person
    // twice with nothing said about it is not.
    const signal =
      namespaces.size > 1 ? 'SOURCE_ID_ACROSS_NAMESPACES' : spaces.size > 1 ? 'SOURCE_ID_ACROSS_IDENTITY_SPACES' : null;
    if (signal === null) continue;
    const acrossNamespaces = signal === 'SOURCE_ID_ACROSS_NAMESPACES';
    const value = key.slice(key.indexOf('|') + 1);
    const clusterId = clusterIdFor(signal, value, bucket.map((record) => record.migrationKey));
    clusters += 1;
    for (const record of bucket) {
      emit({
        clusterId,
        object: record.object,
        migrationKey: record.migrationKey,
        rowLocatorId: record.rowLocatorId,
        filePath: record.filePath,
        rowNumberSource: record.rowNumberSource,
        signal,
        signalValue: value,
        evidence: acrossNamespaces
          ? `the same raw record id appears under: ${[...namespaces].sort(compareCodeUnits).join(', ')}`
          : `the same raw record id appears in identity spaces: ${[...spaces].sort(compareCodeUnits).join(', ')}`,
        conflicts: describeConflicts(bucket),
        whyNotMerged: acrossNamespaces
          ? 'Record ids are only meaningful inside one source system and namespace. The same number in two exports does not describe one record.'
          : 'Each record mapping has its own identity space by default, so two id sequences that happen to overlap are not merged. If these sheets are two halves of one export, give them the same identitySpace and re-run.',
        reasonCode: acrossNamespaces
          ? 'IDENTITY_CROSS_NAMESPACE_ID_COLLISION'
          : 'IDENTITY_SAME_ID_ACROSS_IDENTITY_SPACES',
        notMergedReasonCode: acrossNamespaces
          ? 'IDENTITY_CROSS_NAMESPACE_ID_COLLISION'
          : 'IDENTITY_SAME_ID_ACROSS_IDENTITY_SPACES',
      });
    }
  }
  return clusters;
}

/**
 * What differs between the records of a duplicate-candidate cluster.
 *
 * Read from the values each record delivers rather than from each of the rows
 * behind it. Where a record was built from several rows, what it delivers is
 * what the destination will hold, and that is the difference an operator has
 * to decide about.
 */
function describeConflicts(bucket: readonly DuplicateSubject[]): string {
  // The field list is taken from the values the subjects carry rather than from
  // every field name the records held, and that is the same list. A field no
  // record in the cluster carries a non-empty value for contributes nothing --
  // the loop below drops it -- so a field name that only ever appeared with an
  // omission, a clear or an empty string was already producing nothing before
  // it stopped being written down.
  const fields = sorted(
    [...new Set(bucket.flatMap((subject) => Object.keys(subject.values)))],
    compareCodeUnits,
  );
  const differing: string[] = [];
  for (const fieldName of fields) {
    const values = sorted(
      [
        ...new Set(
          bucket
            .map((subject) => subject.values[fieldName])
            .filter((value): value is string => value !== undefined && value.length > 0),
        ),
      ],
      compareCodeUnits,
    );
    if (values.length > 1) differing.push(`${fieldName}=${describeValues(values)}`);
  }
  return differing.join('; ');
}

/**
 * How many differing values of one field a description shows, and how much of
 * each.
 *
 * This description used to list every distinct value in the cluster, in full,
 * and it is attached to **every** entry the cluster produces. Both halves of
 * that are unbounded in the data, and together they are quadratic: a cluster of
 * n records produces n entries each carrying a description of all n values.
 *
 * It is not a corner case. A company whose contacts all share the office
 * switchboard number is one cluster the size of the customer's CRM, and with
 * 5 KB of text on each record the engine did not produce a large artifact -- it
 * died, at `Array.prototype.join`, with `RangeError: Invalid string length`,
 * because the single string exceeded what V8 will hold. Measured on the way
 * there: `02_EXCEPTIONS/duplicate-candidates.csv` was 891 MB at 5,000 records
 * and 3.58 GB at 10,000, which is four times the bytes for twice the rows.
 *
 * So the description became a **sample with a count**. What a reviewer needs
 * from it is to see that the values differ, enough of them to judge whether the
 * coincidence matters, and how many there were; what nobody needs is every value
 * in the cluster repeated once per member of it. The count is what keeps this
 * honest -- nothing is dropped silently, the entry says how many it did not
 * show -- and the sample is the first few in the order the values were already
 * sorted into, so two runs of one migration still produce the same bytes.
 *
 * The full set has not gone anywhere: every one of these records is in the
 * cluster, one row each, with its own value in the lineage.
 */
const CONFLICT_VALUES_SHOWN = 3;
const CONFLICT_VALUE_CHARACTERS = 80;

function describeValues(values: readonly string[]): string {
  const shown = values.slice(0, CONFLICT_VALUES_SHOWN).map((value) => {
    if (value.length <= CONFLICT_VALUE_CHARACTERS) return `"${value}"`;
    // The length is stated rather than implied by an ellipsis, because "is this
    // value the same as that one" is the question a reviewer is here to answer
    // and two truncations look identical.
    return `"${value.slice(0, CONFLICT_VALUE_CHARACTERS)}"+${String(value.length - CONFLICT_VALUE_CHARACTERS)} more characters`;
  });
  const rest = values.length - shown.length;
  return rest === 0 ? shown.join('/') : `${shown.join('/')} and ${String(rest)} more values`;
}

function carried(value: { readonly intent: ValueIntent } | undefined): string | null {
  return value === undefined ? null : intendedValue(value.intent);
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}

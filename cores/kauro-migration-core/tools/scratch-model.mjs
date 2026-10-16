#!/usr/bin/env node
// A model of the external sort: what it was configured to do, and what it must
// therefore have written.
//
// This replaces a ratio. The gate used to divide cumulative scratch bytes by
// raw source bytes and fail anything over sixty. That number is wrong in kind,
// not in value, and raising it would only have moved the point at which it is
// wrong:
//
//   the denominator is the source file; the numerator is derived facts,
//   records, lineage, edges and encoded index keys, which are not made of the
//   source in any fixed proportion;
//
//   `bytesWritten` is cumulative and counts run generation plus every merge
//   pass, and the number of merge passes grows with the number of runs, which
//   grows with the row count;
//
//   measured here, the same correct algorithm gives 52.6x at 2,006 rows and
//   154-173x at 1,000,000, with no change in complexity and no wasted scratch.
//
// A scale-variant ratio cannot bound a scale-invariant property. So this does
// not bound anything against the source.
//
// The first version of this file then made the opposite mistake, and it was
// refuted by execution rather than by argument. It recomputed the traffic from
// the sort's own `runSize` and `fanIn` and compared the answer with what the
// store had counted — and never asked where `runSize` and `fanIn` came from. A
// synthetic 1,000,000-record family configured `runSize 1 / fanIn 2` writes
// twenty merge passes and 25.1x its payload, seven times what the engine's
// declared 50,000 / 8 writes on the same records, and every fact came back
// true. An audit of arithmetic is not a bound: a sort that agrees with itself
// about having done seven times too much work agrees with itself perfectly.
//
// So the model now states two things, and it needs both:
//
//   1. the sort ran at a configuration the engine declares. `runSize` and
//      `fanIn` are compared against the limit sets the caller supplies,
//      imported from the engine — `DEFAULT_SPOOL_LIMITS` in src/run/spool.ts,
//      and any other set a stage declares for itself. This file carries no copy
//      of them, for the same reason it carries no copy of the scratch budget.
//      A configuration nobody declared is refused, and the refusal says in
//      bytes how much more it writes than the declared one would.
//
//   2. given that configuration, every byte is attributable to a pass the
//      algorithm had to perform, and every pass was one it had to perform. That
//      part is an equality, not a threshold, and it holds at two thousand rows
//      and at a million because it is arithmetic about the algorithm rather
//      than a reading taken at one size.
//
// On checks that were removed rather than kept. An adversarial pass found three
// checks here that could not fail, because both of their sides were moved from
// one number on adjacent lines of the store. Two of those have been made into
// real comparisons by changing where the store gets its numbers from — framing
// is now measured as what went on the device minus what the caller handed over,
// and the live segment count is now read off the store's segment table rather
// than off a counter kept beside `released`. The rest have been deleted, each
// with a note saying which lines made it an identity. A check that cannot fail
// is worse than no check, because it reads as coverage.
//
// Nothing in the exported functions reads a file or imports the engine. They are
// given an instrumented record, a quota, the declared limits and an independent
// measurement of the device, and they do arithmetic — so the same functions
// serve the release-candidate gate, the unit tests, the command line at the
// bottom of this file, and anyone checking a number by hand.

/**
 * @typedef {object} SortFormat
 * @property {number} keyTerminatorBytes  separator between a key and its tie-break
 * @property {number} sequenceBytes       fixed-width input position
 * @property {number} keySeparatorBytes   separator between the sort key and the record
 */

/**
 * @typedef {object} SpoolLimits
 * @property {number} runSize  records held in memory before a run is spilled
 * @property {number} fanIn    segments merged in one pass
 */

/**
 * @typedef {object} SortRecord
 * @property {number} records
 * @property {number} payloadBytes
 * @property {number} keyBytes
 * @property {number} runSize
 * @property {number} fanIn
 * @property {number} initialRuns
 * @property {number} mergePasses
 * @property {number[]} initialRunBytes
 * @property {number[]} initialRunRecords
 * @property {SortFormat} format
 * @property {string|null} resultSegmentId
 * @property {number} resultBytes
 * @property {number} resultRows
 * @property {string|null} resultDigest
 */

// On the two things this file deliberately does not contain.
//
// The canonical scratch budget lives in `src/domain/resource-profile.ts` as
// `SCRATCH_BUDGET_BYTES`. The engine's spool limits live in `src/run/spool.ts`
// as `DEFAULT_SPOOL_LIMITS`. A copy of either here would be a second place for
// it to be true, which is the whole failure mode of a constant a repository
// could compute. So the caller passes both in, imported from where they are
// declared, and what this module does instead is refuse to say anything at all
// when it is not given them. A run measured against a quota nobody configured is
// not evidence about the budget; a sort run at limits nobody declared is not
// evidence about the engine.

/** Code-unit order, the ordering the engine uses everywhere a string is sorted. */
function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function isWholeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * How many merge passes the algorithm owes, worked out by doing the division
 * rather than by taking a logarithm.
 *
 * `Math.ceil(Math.log(n) / Math.log(f))` is off by one whenever the division
 * lands a few ulps above an exact power — 8 runs at fan-in 2 can come out as 4
 * passes instead of 3 — and a complexity check that is occasionally off by one
 * pass is worse than none, because the failure looks exactly like the defect it
 * is meant to catch.
 *
 * A fan-in below two never reduces the run count, so the loop would not
 * terminate. It is refused rather than clamped: a merge of one input is not a
 * merge, `createExternalSorter` already refuses it, and a model that quietly
 * accepted it would hang the gate on a record that should have been rejected in
 * a sentence.
 */
export function mergePassesFor(initialRuns, fanIn) {
  if (!Number.isSafeInteger(fanIn) || fanIn < 2) {
    throw new TypeError(`a merge needs a fan-in of at least two, and this record says ${String(fanIn)}`);
  }
  let remaining = initialRuns;
  let passes = 0;
  while (remaining > 1) {
    remaining = Math.ceil(remaining / fanIn);
    passes += 1;
  }
  return passes;
}

/**
 * Replays the merge tree over the sizes the runs actually came out at.
 *
 * This is the whole model. Each pass takes the segments of the level below in
 * groups of `fanIn` and writes one segment per group — except a group of one,
 * which is carried to the next level unchanged and writes nothing, because
 * `external-sort.ts` refuses to rewrite a segment it would only be copying.
 * Every record appears exactly once at every level and its bytes are identical
 * at every level, because a merge writes back the same composed line it read;
 * so a level always weighs what run generation weighed, and what a pass costs
 * is that weight minus whatever it carried.
 *
 * Sizes rather than counts, because the traffic depends on where the boundaries
 * fell: a final short run carried through three passes costs nothing three
 * times, and a model working from `initialRuns` alone could not say so.
 *
 * @param {number[]} runBytes    sealed size of each initial run, in spill order
 * @param {number[]} runRecords  record count of each initial run, same order
 * @param {number} fanIn
 */
export function replayMergeTree(runBytes, runRecords, fanIn) {
  let levelBytes = [...runBytes];
  let levelRecords = [...runRecords];
  const bytesByPass = [sum(levelBytes)];
  const linesByPass = [sum(levelRecords)];
  const passDetail = [];
  let segmentsSealed = levelBytes.length;

  while (levelBytes.length > 1) {
    const nextBytes = [];
    const nextRecords = [];
    let written = 0;
    let lines = 0;
    let carried = 0;
    let groups = 0;
    for (let index = 0; index < levelBytes.length; index += fanIn) {
      const groupBytes = levelBytes.slice(index, index + fanIn);
      const groupRecords = levelRecords.slice(index, index + fanIn);
      if (groupBytes.length === 1) {
        carried += groupBytes[0];
        nextBytes.push(groupBytes[0]);
        nextRecords.push(groupRecords[0]);
        continue;
      }
      const bytes = sum(groupBytes);
      const records = sum(groupRecords);
      written += bytes;
      lines += records;
      groups += 1;
      segmentsSealed += 1;
      nextBytes.push(bytes);
      nextRecords.push(records);
    }
    passDetail.push({
      pass: bytesByPass.length,
      inputs: levelBytes.length,
      merged: groups,
      carriedBytes: carried,
      bytesWritten: written,
      linesWritten: lines,
    });
    bytesByPass.push(written);
    linesByPass.push(lines);
    levelBytes = nextBytes;
    levelRecords = nextRecords;
  }

  return {
    bytesByPass,
    linesByPass,
    passDetail,
    passes: bytesByPass.length - 1,
    segmentsSealed,
    resultBytes: levelBytes.length === 1 ? levelBytes[0] : 0,
    resultRows: levelRecords.length === 1 ? levelRecords[0] : 0,
  };
}

/**
 * The declared limit sets, checked into a usable shape or refused.
 *
 * A list rather than one set, because this tree declares more than one and each
 * of them is declared for a reason: `DEFAULT_SPOOL_LIMITS` is what the engine
 * sorts its own families at, and `VERIFY_SPOOL_LIMITS` in src/verify/join.ts is
 * smaller because a verification holds several spills open at once and the run
 * that matters is the sum of them. What the model refuses is a configuration
 * nobody declared at all.
 *
 * The order matters in one place only: the first entry is the reference the
 * refusal message costs an undeclared configuration against, so the caller
 * should put the engine's own limits first.
 */
export function normaliseSpoolLimits(spoolLimits) {
  if (!Array.isArray(spoolLimits) || spoolLimits.length === 0) return null;
  const declared = [];
  for (const entry of spoolLimits) {
    if (entry === null || typeof entry !== 'object') return null;
    const runSize = Number(entry.runSize);
    const fanIn = Number(entry.fanIn);
    if (!isWholeCount(runSize) || runSize < 1) return null;
    if (!isWholeCount(fanIn) || fanIn < 2) return null;
    declared.push({ runSize, fanIn });
  }
  return declared;
}

function describeLimits(limits) {
  return limits.map((entry) => `${String(entry.runSize)}/${String(entry.fanIn)}`).join(', ');
}

/**
 * What one external sort was configured to do, what it must therefore have
 * written, and whether that is what it wrote.
 *
 * @param {SortRecord} sort
 * @param {number} framingBytesPerLine  the record separator the store owns
 * @param {SpoolLimits[]} declaredLimits  the engine's limit sets, already normalised
 */
export function modelSort(sort, framingBytesPerLine, declaredLimits) {
  const problems = [];
  const arithmetic = [];
  // Returned when the record cannot be replayed at all — a missing format, a run
  // size of zero, per-run arrays of the wrong length. `unmodellable` is the flag
  // rather than an empty expectation, because a caller that treated "owes
  // nothing" as an expectation would then report every byte the family wrote as
  // unexplained and bury the one sentence that says why.
  const empty = {
    unmodellable: true,
    expectedBytes: 0,
    boundBytes: 0,
    arithmetic,
    problems,
    expectedByPass: [],
    expectedLines: 0,
    expectedSegments: 0,
  };

  for (const [field, value] of [
    ['records', sort.records],
    ['payloadBytes', sort.payloadBytes],
    ['keyBytes', sort.keyBytes],
    ['runSize', sort.runSize],
    ['fanIn', sort.fanIn],
    ['initialRuns', sort.initialRuns],
    ['mergePasses', sort.mergePasses],
  ]) {
    if (!isWholeCount(value)) problems.push(`the sort record's ${field} is ${String(value)}, which is not a whole count`);
  }
  // Refused here rather than left to arithmetic. A run size of zero makes the
  // run count infinite and a fan-in below two makes the merge never finish, so
  // both would take a gate down instead of failing it. `createExternalSorter`
  // refuses the same two shapes at the other end.
  if (isWholeCount(sort.runSize) && sort.runSize < 1) {
    problems.push('the sort record says its run size was zero, and a sort that never fills a run never spills one');
  }
  if (isWholeCount(sort.fanIn) && sort.fanIn < 2) {
    problems.push(`the sort record says it merged ${String(sort.fanIn)} segments at a time, and a merge needs two`);
  }
  if (!Array.isArray(sort.initialRunBytes) || !Array.isArray(sort.initialRunRecords)) {
    problems.push('the sort record carries no per-run sizes, so its traffic cannot be recomputed');
    return empty;
  }
  // Read rather than assumed. A malformed record has to fail this check, not
  // throw a TypeError out of the middle of a gate: an exception is a crash a
  // reader has to diagnose, and a stated problem is an answer.
  const format = sort.format ?? {};
  for (const field of ['keyTerminatorBytes', 'sequenceBytes', 'keySeparatorBytes']) {
    if (!isWholeCount(format[field])) {
      problems.push(`the sort record does not say what its ${field} costs, so the format accounts for nothing`);
    }
  }
  if (problems.length > 0) return empty;

  // 1. The runs are the runs the run size implies.
  //
  // Three separately kept quantities: `records` is counted at push, `runSize` is
  // the configuration, and `initialRuns` is how many segments the sort sealed.
  // A spill that fired early or late moves the third without moving the first
  // two.
  const expectedRuns = sort.records === 0 ? 0 : Math.ceil(sort.records / sort.runSize);
  arithmetic.push(
    `records ${String(sort.records)} at runSize ${String(sort.runSize)} -> initialRuns ${String(expectedRuns)} = ` +
      `${sort.records === 0 ? '0 (nothing to spill)' : `ceil(${String(sort.records)} / ${String(sort.runSize)})`}`,
  );
  if (sort.initialRuns !== expectedRuns) {
    problems.push(
      `it reports ${String(sort.initialRuns)} initial runs where ${String(sort.records)} records at a run size of ` +
        `${String(sort.runSize)} must produce ${String(expectedRuns)}`,
    );
  }
  // A shape guard rather than a claim: the replay needs one size and one record
  // count per run, and a record that does not carry them cannot be modelled at
  // all. It is stated as a problem rather than thrown for the same reason as
  // the format fields above.
  //
  // The run-count disagreement above is not a shape guard and deliberately does
  // not stop the replay — the replay works from the arrays, and a sort that
  // spilled one run too many still has a merge tree worth recomputing. Only
  // arrays that cannot be walked stop it.
  let unmodellable = false;
  if (sort.initialRunBytes.length !== sort.initialRuns) {
    problems.push(
      `it reports ${String(sort.initialRuns)} initial runs and ${String(sort.initialRunBytes.length)} run sizes`,
    );
    unmodellable = true;
  }
  if (sort.initialRunRecords.length !== sort.initialRunBytes.length) {
    problems.push('the per-run byte counts and the per-run record counts are different lengths');
    unmodellable = true;
  }
  if (unmodellable) return empty;

  const spilledRecords = sum(sort.initialRunRecords);
  if (spilledRecords !== sort.records) {
    problems.push(
      `the runs hold ${String(spilledRecords)} records and the sort was given ${String(sort.records)}; ` +
        'records entered the sort that no run wrote down',
    );
  }

  // 2. Every run except the last was full.
  //
  // The waste this catches is a sort that spills before it has to. A run of one
  // record where the configuration allows fifty thousand costs a segment, a
  // seal, and a place in the merge tree, for one record — and it is invisible in
  // a total, because the bytes are the same bytes. The two sides are kept apart:
  // the record counts come back from the store's sealed manifests and the run
  // size is what the caller configured.
  for (let index = 0; index < sort.initialRunRecords.length; index += 1) {
    const held = sort.initialRunRecords[index];
    const last = index === sort.initialRunRecords.length - 1;
    if (held > sort.runSize) {
      problems.push(
        `run ${String(index)} holds ${String(held)} records where the configured run size is ${String(sort.runSize)}`,
      );
    } else if (!last && held !== sort.runSize) {
      problems.push(
        `run ${String(index)} of ${String(sort.initialRunRecords.length)} holds ${String(held)} records and the ` +
          `configured run size is ${String(sort.runSize)}; a run spilled before it was full costs a segment for ` +
          'nothing',
      );
    }
  }

  // 3. Run generation weighs what the format says it must.
  //
  // Every spilled line is `key NUL sequence TAB record LF`. The record and the
  // key were counted as the caller handed them over, before anything was added,
  // so this is a statement about the format and not a restatement of the
  // measurement: if the sequence width were eight and the record claimed
  // sixteen, this identity would miss by eight bytes per record.
  const perRecordFraming =
    format.keyTerminatorBytes + format.sequenceBytes + format.keySeparatorBytes + framingBytesPerLine;
  const expectedRunGeneration = sort.payloadBytes + sort.keyBytes + sort.records * perRecordFraming;
  const actualRunGeneration = sum(sort.initialRunBytes);
  arithmetic.push(
    `run generation ${String(expectedRunGeneration)} bytes = payload ${String(sort.payloadBytes)} + keys ` +
      `${String(sort.keyBytes)} + ${String(sort.records)} x (${String(format.keyTerminatorBytes)} terminator + ` +
      `${String(format.sequenceBytes)} sequence + ${String(format.keySeparatorBytes)} key separator + ` +
      `${String(framingBytesPerLine)} record separator)`,
  );
  if (actualRunGeneration !== expectedRunGeneration) {
    problems.push(
      `run generation wrote ${String(actualRunGeneration)} bytes where the format accounts for ` +
        `${String(expectedRunGeneration)}; ${String(actualRunGeneration - expectedRunGeneration)} bytes per sort are ` +
        'unexplained by payload, keys and framing',
    );
  }

  // 4. The merge tree, replayed over the sizes the runs came out at.
  const tree = replayMergeTree(sort.initialRunBytes, sort.initialRunRecords, sort.fanIn);
  for (const detail of tree.passDetail) {
    arithmetic.push(
      `pass ${String(detail.pass)}: ${String(detail.inputs)} segments at fan-in ${String(sort.fanIn)} -> ` +
        `${String(detail.merged)} merged, ${String(detail.bytesWritten)} bytes rewritten, ` +
        `${String(detail.carriedBytes)} carried unwritten`,
    );
  }

  // 5. The pass count is the complexity the algorithm declares, done as integer
  //    division so an exact power of the fan-in cannot round the wrong way.
  //
  //    `declaredPasses` and `tree.passes` are two implementations of one
  //    recurrence — repeated division against actually grouping the segments —
  //    so comparing them tests the model rather than the sort. That is worth
  //    keeping and it is not the same thing as the identities deleted below:
  //    these two are different algorithms in this file, not one number written
  //    twice on adjacent lines of the store.
  const declaredPasses = mergePassesFor(sort.initialRuns, sort.fanIn);
  arithmetic.push(
    `merge passes ${String(declaredPasses)} = repeated ceil(runs / ${String(sort.fanIn)}) from ` +
      `${String(sort.initialRuns)} down to 1`,
  );
  if (sort.mergePasses !== declaredPasses) {
    problems.push(
      `it performed ${String(sort.mergePasses)} merge passes where ${String(sort.initialRuns)} runs at a fan-in of ` +
        `${String(sort.fanIn)} need ${String(declaredPasses)}; the observed complexity contradicts the declared one`,
    );
  }
  if (tree.passes !== declaredPasses) {
    problems.push(
      `replaying the merge over the run sizes takes ${String(tree.passes)} passes where the fan-in arithmetic says ` +
        `${String(declaredPasses)}`,
    );
  }

  // 6. The answer is the answer.
  if (sort.resultBytes !== tree.resultBytes) {
    problems.push(
      `the surviving segment holds ${String(sort.resultBytes)} bytes where the merge must leave ` +
        `${String(tree.resultBytes)}`,
    );
  }
  if (sort.resultRows !== tree.resultRows) {
    problems.push(
      `the surviving segment holds ${String(sort.resultRows)} records where the merge must leave ` +
        `${String(tree.resultRows)}`,
    );
  }
  if (sort.records > 0 && sort.resultRows !== sort.records) {
    problems.push(
      `${String(sort.records)} records went into the sort and ${String(sort.resultRows)} came out of it`,
    );
  }

  const expectedBytes = sum(tree.bytesByPass);
  arithmetic.push(
    `expected total ${String(expectedBytes)} = ${tree.bytesByPass.map((value) => String(value)).join(' + ')}`,
  );

  // 7. The configuration was one the engine declares.
  //
  // This is the check the first version of this file did not have, and its
  // absence is what made everything above an audit rather than a bound. `runSize`
  // and `fanIn` are the only free parameters in the whole model: fix them and
  // the traffic is determined by the record count, the payload and the format;
  // leave them free and the same records can cost anything at all while every
  // other check here passes.
  //
  // What "necessary" means is not invented here. It is whatever the engine
  // declares it to be, imported by the caller from where it is declared, and the
  // refusal quotes the difference in bytes so that "seven times more than it
  // must" is a number a reader can check rather than an adjective.
  //
  // The honest limit of this check, stated rather than left to be discovered: it
  // moves with the constant it imports. If the declared limits themselves became
  // 1 / 2, a sort at 1 / 2 would match them and the model would report a
  // conforming run. That is a change to a source file under review, not
  // something a script can do to an artifact, which is the line this front is
  // drawn on.
  const matched = declaredLimits.find(
    (entry) => entry.runSize === sort.runSize && entry.fanIn === sort.fanIn,
  );
  const reference = matched ?? declaredLimits[0];
  const referenceRuns = sort.records === 0 ? 0 : Math.ceil(sort.records / reference.runSize);
  const referencePasses = mergePassesFor(referenceRuns, reference.fanIn);
  const boundBytes = expectedRunGeneration * (1 + referencePasses);
  arithmetic.push(
    `declared-limit bound ${String(boundBytes)} = run generation ${String(expectedRunGeneration)} x (1 + ` +
      `${String(referencePasses)} passes), where ${String(sort.records)} records at the declared runSize ` +
      `${String(reference.runSize)} / fanIn ${String(reference.fanIn)} make ${String(referenceRuns)} runs`,
  );
  if (matched === undefined) {
    const excess = boundBytes === 0 ? 0 : expectedBytes / boundBytes;
    problems.push(
      `it ran at runSize ${String(sort.runSize)} / fanIn ${String(sort.fanIn)}, which is not one of the ` +
        `configurations the engine declares (${describeLimits(declaredLimits)}). At the declared runSize ` +
        `${String(reference.runSize)} / fanIn ${String(reference.fanIn)} these ${String(sort.records)} records need ` +
        `${String(referencePasses)} merge pass(es) and ${String(boundBytes)} bytes of scratch; this configuration ` +
        `needs ${String(declaredPasses)} and writes ${String(expectedBytes)}, which is ${excess.toFixed(1)}x as much. ` +
        'A sort configured to write more than the declared limits require is waste, not evidence.',
    );
  }

  // On the bound, which is reported and no longer compared.
  //
  // There used to be a check here reading `expectedBytes > boundBytes`, with
  // `boundBytes` derived from the run generation this sort actually performed
  // times one plus the passes it actually took. It could not fail. Every level
  // of the merge weighs what run generation weighed and a pass rewrites at most
  // a whole level, so the sum of the levels is at most run generation times one
  // plus the pass count, with equality when nothing is carried; an adversarial
  // pass searched 20,000 randomly shaped conforming records and it fired zero
  // times.
  //
  // The figure survives because it is the sentence somebody asks for — what does
  // this cost at ten times the rows — and it is now worth asking, because it is
  // derived from the declared configuration and the record count rather than
  // from this run's observed pass count. Scale the record count and the bound
  // scales with it. It is not asserted against `expectedBytes`, because with the
  // configuration pinned by the check above the comparison is unreachable again,
  // and an unreachable check reads as coverage.

  return {
    expectedBytes,
    boundBytes,
    expectedByPass: tree.bytesByPass,
    expectedLines: sum(tree.linesByPass),
    expectedSegments: tree.segmentsSealed,
    arithmetic,
    problems,
  };
}

/**
 * Recomputes the traffic one instrumented family must have produced, and says
 * whether that is what it produced.
 *
 * The verdict is an equality. There is no tolerance and no ceiling: either every
 * byte the store counted belongs to a pass the algorithm had to perform, or some
 * of them do not and the difference is named.
 *
 * @param {object} family  one entry of `ScratchUsage.byFamily`
 * @param {{framingBytesPerLine: number, spoolLimits: SpoolLimits[]}} options
 */
export function modelFamilyTraffic(family, options) {
  const problems = [];
  const arithmetic = [];
  const name = String(family.family);
  const declaredLimits = normaliseSpoolLimits(options.spoolLimits);

  if (declaredLimits === null) {
    return {
      family: name,
      verdict: 'UNMODELLED',
      expectedBytes: null,
      actualBytes: Number(family.bytesWritten ?? 0),
      arithmetic,
      problems: [
        `${name} cannot be modelled: no declared spool limits were supplied. They are DEFAULT_SPOOL_LIMITS from ` +
          'src/run/spool.ts, and this module refuses to carry its own copy, because a sort measured against limits ' +
          'the model invented is not evidence about the engine.',
      ],
    };
  }

  if (!Array.isArray(family.bytesWrittenByPass)) {
    return {
      family: name,
      verdict: 'UNMODELLED',
      expectedBytes: null,
      actualBytes: Number(family.bytesWritten ?? 0),
      arithmetic,
      problems: [
        `${name} carries no per-pass accounting. This evidence was produced before the scratch store split its ` +
          'running total by merge pass; it cannot be modelled, and it is not evidence about this candidate. Re-run ' +
          'tools/capacity.mjs --founding against the current build.',
      ],
    };
  }

  const sorts = Array.isArray(family.sorts) ? family.sorts : [];
  const actualBytes = Number(family.bytesWritten);
  const unattributed = Number(family.bytesWrittenUnattributed ?? 0);

  if (sorts.length === 0 && actualBytes > 0) {
    problems.push(
      `${name} wrote ${String(actualBytes)} bytes and no external sort claimed them. Traffic no algorithm accounts ` +
        'for is exactly what this model exists to refuse.',
    );
  }
  if (unattributed !== 0) {
    problems.push(
      `${name} wrote ${String(unattributed)} bytes through a segment that named no merge pass, so no model explains ` +
        'them',
    );
  }

  // Element-wise across sorts: two sorts in one family both write their pass-p
  // bytes into slot p, so the expectation for a slot is the sum of what each
  // sort owes it.
  const expectedByPass = [];
  let expectedLines = 0;
  let expectedSegments = 0;
  let expectedBytes = 0;
  let boundBytes = 0;
  let unmodellable = false;
  for (const sort of sorts) {
    const modelled = modelSort(sort, options.framingBytesPerLine, declaredLimits);
    for (const problem of modelled.problems) problems.push(`${name}: ${problem}`);
    for (const line of modelled.arithmetic) arithmetic.push(`${name}  ${line}`);
    if (modelled.unmodellable === true) unmodellable = true;
    modelled.expectedByPass.forEach((value, index) => {
      while (expectedByPass.length <= index) expectedByPass.push(0);
      expectedByPass[index] += value;
    });
    expectedLines += modelled.expectedLines;
    expectedSegments += modelled.expectedSegments;
    expectedBytes += modelled.expectedBytes;
    boundBytes += modelled.boundBytes ?? 0;
  }

  // A sort that could not be replayed at all takes the family with it. Every
  // comparison below is against a replay that did not happen, so running them
  // would print the family's whole traffic as unexplained underneath the one
  // sentence that says why it could not be explained.
  if (unmodellable) {
    return {
      family: name,
      verdict: 'UNMODELLED',
      expectedBytes: null,
      actualBytes,
      boundBytes,
      arithmetic,
      problems,
    };
  }

  // A pass the store recorded and the model does not owe is the shape an extra
  // merge would take, and it is checked by slot rather than by total so that a
  // pass moving bytes from one slot to another cannot hide inside a sum. The two
  // sides are the store's per-pass counters and this file's replay of the merge
  // tree, which are as far apart as anything here gets.
  const actualByPass = family.bytesWrittenByPass.map((value) => Number(value));
  const slots = Math.max(actualByPass.length, expectedByPass.length);
  for (let index = 0; index < slots; index += 1) {
    const expected = expectedByPass[index] ?? 0;
    const actual = actualByPass[index] ?? 0;
    if (expected === actual) continue;
    const label = index === 0 ? 'run generation' : `merge pass ${String(index)}`;
    if (expected === 0) {
      problems.push(
        `${name} wrote ${String(actual)} bytes in ${label}, which the algorithm never performs; ` +
          `${String(sorts.length)} sort(s) in this family owe ${String(expectedByPass.length - 1)} merge passes`,
      );
    } else {
      problems.push(`${name} wrote ${String(actual)} bytes in ${label} where the model owes ${String(expected)}`);
    }
  }

  // Deleted rather than kept: `sum(bytesWrittenByPass) + bytesWrittenUnattributed
  // === bytesWritten`.
  //
  // All three counters move inside one `if` in `account`
  // (src/scratch/filesystem-scratch-store.ts), from the same `delta`, within four
  // lines of each other. There is no path that moves one without the others, so
  // the sum could only ever disagree on a record edited after it was produced —
  // and evidence edited after it was produced is caught where it should be, by
  // the manifest digest the candidate provenance stamps onto every evidence
  // file, not by arithmetic the same file could be edited to satisfy.
  //
  // What replaced it is the run-level comparison in `checkScratchRun`: the total
  // the store recorded against the total this model owes. That has one side from
  // the store and one from the replay, and it fails on everything the deleted
  // check would have caught.

  if (Number(family.linesWritten) !== expectedLines && sorts.length > 0) {
    problems.push(
      `${name} appended ${String(family.linesWritten)} lines where the model owes ${String(expectedLines)}`,
    );
  }
  // Framing, now that it is measured rather than multiplied.
  //
  // `framingBytes` is accumulated in the store as what went on the device minus
  // what the caller handed over, one append at a time. This side is the line
  // count times the separator width the store reports. Before the store changed,
  // both sides came from `write.lines` on adjacent lines and the check could not
  // fail; now a separator that is written twice, or one that stops being a
  // single byte, or a caller whose line already ends in one, makes them differ.
  const expectedFraming = Number(family.linesWritten) * options.framingBytesPerLine;
  if (Number(family.framingBytes) !== expectedFraming) {
    problems.push(
      `${name} measured ${String(family.framingBytes)} bytes of framing on the device for ` +
        `${String(family.linesWritten)} lines, where one record separator each is ${String(expectedFraming)}`,
    );
  }

  arithmetic.push(
    `${name}  actual ${String(actualBytes)} bytes over ${String(actualByPass.length)} write(s), of which framing ` +
      `${String(family.framingBytes)} for ${String(family.linesWritten)} lines`,
  );

  return {
    family: name,
    verdict: problems.length === 0 ? 'CONFORMS' : 'DEVIATES',
    expectedBytes,
    actualBytes,
    boundBytes,
    expectedSegments,
    expectedLines,
    arithmetic,
    problems,
  };
}

/**
 * Accepts the per-family accounting in either shape it is written in.
 *
 * `ScratchUsage.byFamily` is a list, because that is what the store returns.
 * Founding evidence carries the same records as an object keyed by family name,
 * which is the shape the release-candidate gate has always read.
 *
 * The previous round wrote both shapes into the evidence file, on the argument
 * that a model recomputing per-pass traffic needs an order the runtime cannot
 * rearrange. It does not: this function imposes code-unit order on whichever
 * shape it is given, so the object's enumeration order never reaches anything,
 * and the second copy was a few hundred kilobytes of duplicate `sorts` arrays in
 * a committed artifact for no gain. tools/capacity.mjs now writes one shape.
 */
function familiesOf(byFamily) {
  if (Array.isArray(byFamily)) return [...byFamily].sort((a, b) => compareCodeUnits(String(a.family), String(b.family)));
  if (byFamily !== null && typeof byFamily === 'object') {
    return Object.keys(byFamily)
      .sort(compareCodeUnits)
      .map((family) => ({ family, ...byFamily[family] }));
  }
  return [];
}

/**
 * The whole-run check, as three facts a gate can state.
 *
 * They are separate because they fail for different reasons and a caller has to
 * be able to say which one failed. Being inside the quota says nothing about
 * being proportionate; conforming to the model says nothing about having
 * released anything; and a lifecycle that closes says nothing about the peak.
 *
 * @param {object} input
 * @param {object} input.usage             a `ScratchUsage`, or founding evidence shaped like one
 * @param {number} input.quotaBytes        the canonical scratch budget, imported from the resource profile
 * @param {SpoolLimits[]} input.spoolLimits  the limit sets the engine declares, imported from where they are declared
 * @param {number} input.devicePeakBytes   the high-water mark of the scratch directory, walked from outside the store
 */
export function checkScratchRun(input) {
  const usage = input.usage ?? {};
  const quotaBytes = input.quotaBytes;
  const declaredLimits = normaliseSpoolLimits(input.spoolLimits);
  const families = familiesOf(usage.byFamily ?? usage.scratchByFamily ?? null);
  const framingBytesPerLine = Number(usage.framingBytesPerLine ?? usage.scratchFramingBytesPerLine);
  const totalWritten = Number(usage.bytesWritten ?? usage.scratchBytesWritten);
  const peakBytes = Number(usage.peakBytes ?? usage.scratchPeakLiveBytes);
  const liveBytes = Number(usage.bytes ?? usage.scratchLiveBytes);
  const recordedQuota = Number(usage.quotaBytes ?? usage.scratchQuotaBytes);
  const devicePeakBytes = Number(input.devicePeakBytes);

  const facts = [];
  const push = (name, value, detail) => {
    facts.push({ name, value, derivation: 'INSTRUMENTED', detail });
    return value;
  };
  const refuse = (detail) => {
    push('scratch_peak_bounded', false, detail);
    push('scratch_write_model_conforms', false, detail);
    push('scratch_lifecycle_complete', false, detail);
    return { facts, families: [], duplicates: [], expectedBytes: 0, actualBytes: totalWritten, problems: [detail] };
  };

  if (!isWholeCount(quotaBytes) || quotaBytes === 0) {
    return refuse(
      'no canonical scratch quota was supplied to the model. It is SCRATCH_BUDGET_BYTES from ' +
        'src/domain/resource-profile.ts, and this module refuses to carry its own copy of it: a budget that is true ' +
        'in two files is a budget that will one day be true in one.',
    );
  }

  if (declaredLimits === null) {
    return refuse(
      'no declared spool limits were supplied to the model. They are DEFAULT_SPOOL_LIMITS from src/run/spool.ts, ' +
        'and any other set a stage declares for itself. Without them the model can recompute what a sort did but ' +
        'not whether it was configured to do seven times more than it had to, which is the difference between an ' +
        'audit and a bound.',
    );
  }

  if (!isWholeCount(framingBytesPerLine) || framingBytesPerLine === 0) {
    return refuse(
      'the instrumented record does not say what the store charges in framing per line, so no family traffic can be ' +
        'reconstructed from the format. Re-run tools/capacity.mjs --founding against the current build.',
    );
  }

  // ------------------------------------------------------- scratch_peak_bounded
  //
  // What this fact used to say, and why it said nothing.
  //
  // It compared the store's own `peakBytes` against the quota. `account` throws
  // SCRATCH_QUOTA_EXCEEDED the moment live bytes pass the quota
  // (src/scratch/filesystem-scratch-store.ts), so any run that finished and
  // produced evidence satisfies that comparison by construction. The fact was
  // made true by the harness having run, which is the exact failure mode this
  // front exists to remove.
  //
  // What it says now is a statement about the device, made from outside the
  // store. `devicePeakBytes` is a walk of the scratch directory — the harness
  // samples it at stage boundaries, a test walks it before disposal — and the
  // store does not maintain it, cannot see it and does not enforce anything
  // about it. It is pinned from both sides:
  //
  //   the store's live total <= what the device held <= the store's own peak
  //
  // The lower bound is what stops a caller from passing zero: the device must
  // have held at least the bytes the store says are still on it. The upper bound
  // is the real check — bytes on the device that the store's ledger never
  // counted are the one way a quota can be exceeded without `account` noticing,
  // and a walk is the only thing that can see them.
  const peakProblems = [];
  if (!Number.isFinite(devicePeakBytes) || devicePeakBytes < 0) {
    peakProblems.push(
      'no independent measurement of the scratch directory was supplied. The store enforces its own ledger against ' +
        'the quota, so its ledger cannot be the evidence that the quota held; a walk of the directory can be.',
    );
  }
  if (!Number.isFinite(peakBytes)) {
    peakProblems.push('the record does not carry an instrumented peak of live scratch bytes');
  }
  if (!Number.isFinite(liveBytes)) {
    peakProblems.push('the record does not say how many bytes the store still held when it was read');
  }
  if (peakProblems.length === 0) {
    if (devicePeakBytes > quotaBytes) {
      peakProblems.push(
        `the scratch directory held ${String(devicePeakBytes)} bytes against a quota of ${String(quotaBytes)}`,
      );
    }
    if (devicePeakBytes > peakBytes) {
      peakProblems.push(
        `the scratch directory held ${String(devicePeakBytes)} bytes and the store's ledger never admits to more ` +
          `than ${String(peakBytes)}; ${String(devicePeakBytes - peakBytes)} bytes were on the device that the ` +
          'accounting never counted, and the quota is enforced against the accounting',
      );
    }
    if (devicePeakBytes < liveBytes) {
      peakProblems.push(
        `the scratch directory is measured at ${String(devicePeakBytes)} bytes while the store still holds ` +
          `${String(liveBytes)}; a high-water mark below what is currently live is not a measurement of this run`,
      );
    }
  }
  // Kept, and worth saying exactly what it is. Both sides are the same constant
  // read by two different processes at two different times: the harness
  // constructed the store with SCRATCH_BUDGET_BYTES when the run happened, the
  // caller imports it now. That makes it a staleness check rather than a
  // measurement — evidence produced against a budget that has since moved, or by
  // a host that configured its own number, is refused — and it is the only thing
  // standing between "this run was under a quota" and "this run was under the
  // budget".
  if (!Number.isFinite(recordedQuota)) {
    peakProblems.push('the record does not say what quota the store was constructed with');
  } else if (recordedQuota !== quotaBytes) {
    peakProblems.push(
      `the store was given a quota of ${String(recordedQuota)} bytes and the canonical budget is ` +
        `${String(quotaBytes)}; this run was not measured against the budget`,
    );
  }
  // Deleted rather than kept: `family.peakBytes > quotaBytes`. A family's live
  // bytes are a summand of the store's live bytes, so a family peak can never
  // exceed the run peak, which can never exceed the quota that `account`
  // enforces. It was a third statement of a comparison that was already
  // unreachable twice over.
  push(
    'scratch_peak_bounded',
    peakProblems.length === 0,
    peakProblems.length === 0
      ? `the scratch directory was measured at ${String(devicePeakBytes)} bytes, between the ${String(liveBytes)} ` +
          `bytes the store still held and the ${String(peakBytes)} bytes its ledger peaked at, and inside the ` +
          `canonical quota of ${String(quotaBytes)} bytes, which is the quota the store was constructed with; ` +
          `${String(families.length)} families`
      : peakProblems.join('; '),
  );

  // ------------------------------------------------ scratch_write_model_conforms
  const modelled = families.map((family) =>
    modelFamilyTraffic(family, { framingBytesPerLine, spoolLimits: declaredLimits }),
  );
  const modelProblems = [];
  for (const result of modelled) modelProblems.push(...result.problems);

  // The run total, against what the model owes rather than against the sum of
  // the parts.
  //
  // Summing the families and comparing that with the run total was an identity:
  // `account` raises `bytesWritten` and `family.bytesWritten` from the same
  // `delta` on consecutive lines. This compares the store's total with the total
  // the replay owes, which has one side from the store and one from this file,
  // and it catches everything the sum would have caught and more.
  const modelledEverything = modelled.every((result) => result.verdict !== 'UNMODELLED');
  const expectedTotal = modelled.reduce((total, result) => total + (result.expectedBytes ?? 0), 0);
  if (!Number.isFinite(totalWritten)) {
    modelProblems.push('the record does not carry an instrumented total of scratch bytes written');
  } else if (modelledEverything && totalWritten !== expectedTotal) {
    modelProblems.push(
      `the run recorded ${String(totalWritten)} bytes written and the model of run generation and every merge pass ` +
        `owes ${String(expectedTotal)}; ${String(totalWritten - expectedTotal)} bytes belong to no pass of any ` +
        'algorithm',
    );
  }

  // Two families holding the same bytes under the same key.
  //
  // This was a quarter of everything a founding run wrote: `records`,
  // `records-after-conflicts` and `records-validated` were three byte-identical
  // spills of one dataset, and each of them conformed to the model perfectly on
  // its own. The digest of a sort's answer is what makes that sayable at all.
  //
  // The rule refuses three and permits two, and the reason is what a second copy
  // is for. `verify-ledger-<type>` and `verify-written-<type>` in
  // src/verify/verify-package.ts are byte-identical in every package that
  // verifies, and that is not waste — it is the check. One is the delivered
  // relationships as the ledger records them, the other is the same
  // relationships as the import file spells them, they are spilled under the
  // same key, and `coGroup` walks them in step; if they were not identical the
  // verification would fail. Building the second by reading the first would make
  // the comparison vacuous, so the second copy is the whole point of it.
  //
  // A corroboration has two sides. A third byte-identical materialisation
  // settles nothing the second did not already settle, and that is exactly the
  // shape the repository shipped. So two is permitted and three is refused, and
  // the count of every duplicate is reported either way so that a reader sees
  // what a permitted pair costs rather than only being told it was allowed.
  //
  // What would make this exact rather than arity-based, named here because it is
  // a change in files this front does not own: `ScratchFamilyDeclaration`
  // (src/scratch/scratch-store.ts) gaining a statement of what a family
  // corroborates, declared at `openKeyedSpill` (src/verify/join.ts) and
  // `openFamily` (src/run/spool.ts). Nothing in the usage record says today what
  // a family was derived from, so nothing in this file can tell a genuine second
  // reading from an avoidable copy except by counting them.
  const CORROBORATION_SIDES = 2;
  const byDigest = new Map();
  for (const family of families) {
    for (const sort of Array.isArray(family.sorts) ? family.sorts : []) {
      if (sort.resultDigest === null || sort.resultDigest === undefined) continue;
      if (Number(sort.resultRows) === 0) continue;
      const seen = byDigest.get(sort.resultDigest) ?? [];
      seen.push({ family: String(family.family), bytes: Number(sort.resultBytes), rows: Number(sort.resultRows) });
      byDigest.set(sort.resultDigest, seen);
    }
  }
  const duplicates = [];
  for (const [digest, seen] of [...byDigest.entries()].sort((a, b) => compareCodeUnits(a[0], b[0]))) {
    if (seen.length < 2) continue;
    const names = seen.map((entry) => entry.family);
    duplicates.push({
      digest,
      families: names,
      bytes: seen[0].bytes,
      rows: seen[0].rows,
      permitted: seen.length <= CORROBORATION_SIDES,
    });
    if (seen.length <= CORROBORATION_SIDES) continue;
    modelProblems.push(
      `${names.join(', ')} — ${String(seen.length)} families — materialise the same ${String(seen[0].bytes)} bytes ` +
        `over ${String(seen[0].rows)} records under the same key. Two readings of one fact corroborate each other; ` +
        'a third corroborates nothing the second did not, and is a projection that does not need to exist on the ' +
        'device.',
    );
  }

  const duplicateNote =
    duplicates.length === 0
      ? 'no two families materialise the same bytes'
      : `${String(duplicates.length)} digest(s) materialised more than once, costing ` +
        `${String(duplicates.reduce((total, entry) => total + entry.bytes * (entry.families.length - 1), 0))} bytes ` +
        'in second and later copies';
  push(
    'scratch_write_model_conforms',
    modelProblems.length === 0,
    modelProblems.length === 0
      ? `${String(families.length)} families wrote ${String(totalWritten)} bytes at the declared limits ` +
          `(${describeLimits(declaredLimits)}), and the model of run generation and every merge pass owes exactly ` +
          `${String(expectedTotal)}; ${duplicateNote}`
      : modelProblems.join('; '),
  );

  // ---------------------------------------------------- scratch_lifecycle_complete
  const lifecycleProblems = [];
  for (const family of families) {
    const name = String(family.family);
    const sealed = Number(family.segmentsSealed);
    const live = Number(family.segments);
    const released = Number(family.released);
    if (!Number.isFinite(sealed)) {
      lifecycleProblems.push(`${name} does not say how many segments it ever sealed`);
      continue;
    }
    // The store's segment table against two counters kept apart from it. This
    // was an identity until the store stopped keeping a live counter beside
    // `released`: `segments` is now the number of sealed segments the store can
    // still open, counted off the map that decides that, so a segment dropped
    // from the map without being counted as released — or sealed into it without
    // being counted as sealed — is a disagreement rather than an impossibility.
    if (live + released !== sealed) {
      lifecycleProblems.push(
        `${name} sealed ${String(sealed)} segments, holds ${String(live)} and released ${String(released)}; ` +
          `${String(sealed - live - released)} are unaccounted for`,
      );
    }
    const sorts = Array.isArray(family.sorts) ? family.sorts : [];
    const answers = sorts.filter((sort) => sort.resultSegmentId !== null && sort.resultSegmentId !== undefined);
    // Every segment an external sort writes is spent the moment the pass above
    // it has been written, except the one holding the answer. A family holding
    // more segments than it has answers is holding a spent run, and the quota
    // is carrying it for nothing.
    if (live > answers.length) {
      lifecycleProblems.push(
        `${name} holds ${String(live)} segments and its ${String(sorts.length)} sort(s) produce ` +
          `${String(answers.length)} answer(s); ${String(live - answers.length)} spent segment(s) were never released`,
      );
    }
    const answerBytes = answers.reduce((total, sort) => total + Number(sort.resultBytes), 0);
    if (Number(family.liveBytes) > answerBytes) {
      lifecycleProblems.push(
        `${name} holds ${String(family.liveBytes)} bytes where its answers weigh ${String(answerBytes)}`,
      );
    }
    if (live === answers.length && answers.length > 0 && Number(family.liveBytes) !== answerBytes) {
      lifecycleProblems.push(
        `${name} holds every answer it produced but ${String(family.liveBytes)} bytes rather than ` +
          `${String(answerBytes)}`,
      );
    }
    if (Number(family.liveBytes) === 0 && live !== 0) {
      lifecycleProblems.push(`${name} holds ${String(live)} segments weighing nothing`);
    }
    const modelledFamily = modelled.find((result) => result.family === name);
    if (modelledFamily !== undefined && modelledFamily.expectedSegments !== undefined && sorts.length > 0) {
      if (sealed !== modelledFamily.expectedSegments) {
        lifecycleProblems.push(
          `${name} sealed ${String(sealed)} segments where run generation and its merge passes need ` +
            `${String(modelledFamily.expectedSegments)}`,
        );
      }
    }
  }
  const releasedTotal = families.reduce((total, family) => total + Number(family.released), 0);
  const sealedTotal = families.reduce((total, family) => total + Number(family.segmentsSealed), 0);
  push(
    'scratch_lifecycle_complete',
    lifecycleProblems.length === 0,
    lifecycleProblems.length === 0
      ? `${String(sealedTotal)} segments sealed and ${String(releasedTotal)} released as they were spent, across ` +
          `${String(families.length)} families, each holding exactly the answers its sorts produced`
      : lifecycleProblems.join('; '),
  );

  return {
    facts,
    families: modelled,
    duplicates,
    expectedBytes: expectedTotal,
    actualBytes: totalWritten,
    problems: [...peakProblems, ...modelProblems, ...lifecycleProblems],
  };
}

/**
 * The three fact names, so a caller states them rather than spells them.
 *
 * A gate that typed one of these by hand and got it wrong would report a fact
 * nothing consumes, and pass.
 */
export const SCRATCH_FACT_NAMES = ['scratch_peak_bounded', 'scratch_write_model_conforms', 'scratch_lifecycle_complete'];

// --------------------------------------------------------------------------
// The command line
// --------------------------------------------------------------------------
//
// The model is only worth having if something runs it, and the first round
// shipped it with exactly one importer — the unit tests. This is the second, and
// it is the one that matters: it reads committed founding evidence, imports the
// budget and the spool limits from the engine rather than being handed them, and
// exits non-zero when a fact is false.
//
//   node tools/scratch-model.mjs qualification/capacity/*.json
//
// It imports from `dist/`, so it needs a build; the exported functions above do
// not, which is why they are exported and this is at the bottom behind a guard.
//
// Still owed, and not this front's file to change:
// tools/release-candidate-gate.mjs still declares SCRATCH_AMPLIFICATION_CEILING
// = 60 and still decides `scratch_amplification_explained` by dividing scratch
// bytes by source bytes. That fact is the one these three replace. Until its
// owner wires them in, the ceiling is what the release-candidate gate believes,
// and this command is the only thing in the tree that consumes the model.

async function main(argv) {
  const { readFileSync } = await import('node:fs');
  const { SCRATCH_BUDGET_BYTES } = await import('../dist/src/domain/resource-profile.js');
  const { DEFAULT_SPOOL_LIMITS } = await import('../dist/src/run/spool.js');

  // The engine's own limits, and then whatever else a stage declares for itself.
  // `VERIFY_SPOOL_LIMITS` (src/verify/join.ts) is deliberately smaller — a
  // verification holds several spills open at once — and it is a module-local
  // const rather than an export, so it cannot be imported here. Restating it
  // would be exactly the copied constant this whole file refuses, so instead the
  // families that use it are refused and the message says why. Exporting that
  // one const is the one-line change that closes it, and it belongs to whoever
  // owns src/verify/join.ts.
  const declared = [DEFAULT_SPOOL_LIMITS];
  let verifyLimits;
  try {
    ({ VERIFY_SPOOL_LIMITS: verifyLimits } = await import('../dist/src/verify/join.js'));
  } catch {
    // The module moved or the build is partial. Either way the limits were not
    // declared to this run, and a family that used them is refused rather than
    // guessed at.
    verifyLimits = undefined;
  }
  if (verifyLimits !== undefined) declared.push(verifyLimits);

  const paths = argv.filter((entry) => !entry.startsWith('--'));
  if (paths.length === 0) {
    process.stderr.write('usage: node tools/scratch-model.mjs <capacity evidence json>...\n');
    return 64;
  }
  if (verifyLimits === undefined) {
    process.stdout.write(
      'note: src/verify/join.ts does not export VERIFY_SPOOL_LIMITS, so the verifier families in this evidence ' +
        'will be refused as configured at limits nothing declares. Export it there rather than restating it here.\n\n',
    );
  }

  let failures = 0;
  for (const path of paths) {
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    const measured = evidence.measured ?? {};
    const result = checkScratchRun({
      usage: { ...measured, scratchByFamily: evidence.scratchByFamily ?? null },
      quotaBytes: SCRATCH_BUDGET_BYTES,
      spoolLimits: declared,
      devicePeakBytes: measured.peakScratchBytes,
    });
    process.stdout.write(`${path}\n`);
    for (const entry of result.facts) {
      if (entry.value !== true) failures += 1;
      process.stdout.write(`  ${entry.value === true ? 'TRUE ' : 'FALSE'}  ${entry.name}\n          ${entry.detail}\n`);
    }
    process.stdout.write('\n');
  }
  return failures === 0 ? 0 : 1;
}

// Run only when this file is the entry point, so importing it costs nothing and
// needs no build.
if (process.argv[1] !== undefined) {
  const { pathToFileURL } = await import('node:url');
  if (pathToFileURL(process.argv[1]).href === import.meta.url) {
    process.exitCode = await main(process.argv.slice(2));
  }
}

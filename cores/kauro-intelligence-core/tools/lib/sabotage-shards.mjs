/**
 * Sharding of the sabotage run, and the merge that turns the shards back into
 * the one qualification report.
 *
 * The inventory is partitioned by position: mutation number p (0-based, in the
 * order loadInventory returns them — inventory files sorted by name, then
 * declaration order) belongs to shard (p mod n) + 1 of n. The partition is a
 * pure function of the inventory and n, so the merge recomputes it from the
 * tree it runs in and does not have to believe what a shard says about itself.
 *
 * A shard report is mode QUALIFICATION-SHARD. It never qualifies on its own
 * (`qualifies` is false, verifySabotageReport refuses it as "not a
 * QUALIFICATION run"). Only mergeShardReports can produce a report of mode
 * QUALIFICATION from shards, and it does so only when:
 *   - exactly the n shards 1..n are present, each once, each of count n;
 *   - every shard names the same commit and tree as the checkout the merge
 *     runs in, was produced on a clean tree, and carries the same inventory
 *     (files, digests, ids), production-file list and producer hashes as
 *     this checkout;
 *   - every shard's baseline passed;
 *   - every shard holds exactly the records of its own partition: no more, no
 *     fewer, none twice, none from another shard, each naming the inventory
 *     file and gate the inventory names;
 *   - every record is KILLED, and every shard's own counts and flags agree
 *     with its records.
 * The merged report then goes through the unchanged verifySabotageReport,
 * which recounts everything over the whole inventory and re-hashes the
 * production files.
 */
import { SABOTAGE_GATE, recount, sha256Of } from './verify-sabotage-report.mjs';

export const SHARD_MODE = 'QUALIFICATION-SHARD';

/** "k/n" with 1 <= k <= n; anything else is null. */
export function parseShard(text) {
  const match = /^([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})$/u.exec(String(text));
  if (match === null) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  return index <= count ? { index, count } : null;
}

/** The mutations of shard `index` of `count`, in inventory order. */
export function selectShard(mutations, { index, count }) {
  return mutations.filter((_, position) => position % count === index - 1);
}

/** One digest for the inventory a report was produced against: file digests and the ordered ids. */
export function inventoryDigest(files, ids) {
  return sha256Of(JSON.stringify({ files: files.map((entry) => ({ file: entry.file, sha256: entry.sha256 })), ids: ids.map((entry) => entry.id) }));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge shard reports into one QUALIFICATION report for `current`.
 * Returns { ok, problems, report }; report is null unless ok.
 */
export function mergeShardReports(reports, count, current) {
  const problems = [];
  if (!Number.isInteger(count) || count < 1) return { ok: false, problems: [`the shard count ${String(count)} is not a positive integer`], report: null };
  const mutations = current.inventory.mutations;
  const ids = mutations.map((mutation) => ({ id: mutation.id, inventoryFile: mutation.inventoryFile, file: mutation.file, gate: mutation.gate }));
  if (count > mutations.length) problems.push(`${String(count)} shards over ${String(mutations.length)} mutations would leave a shard empty`);
  const digest = inventoryDigest(current.inventory.files, ids);
  const productionNow = [...new Set(mutations.map((mutation) => mutation.file))].sort();
  const filesNow = current.inventory.files.map((entry) => ({ file: entry.file, sha256: entry.sha256 }));

  // Presence: each of 1..count exactly once.
  const byIndex = new Map();
  for (const [position, report] of reports.entries()) {
    const label = `report #${String(position + 1)}`;
    if (report === null || typeof report !== 'object') {
      problems.push(`${label} is not a report`);
      continue;
    }
    const { index, count: reportedCount } = report.shard ?? {};
    if (!Number.isInteger(index) || index < 1 || index > count) {
      problems.push(`${label} names shard ${String(index)}/${String(reportedCount)}, outside 1..${String(count)}`);
      continue;
    }
    if (reportedCount !== count) problems.push(`shard ${String(index)} says it is of ${String(reportedCount)}, the merge expects ${String(count)}`);
    if (byIndex.has(index)) problems.push(`shard ${String(index)}/${String(count)} appears more than once`);
    else byIndex.set(index, report);
  }
  for (let index = 1; index <= count; index += 1) if (!byIndex.has(index)) problems.push(`shard ${String(index)}/${String(count)} is missing`);

  const subject = current.subject;
  if (!subject.resolved) problems.push('the checkout the merge runs in has no resolvable git subject');
  if (subject.dirty) problems.push('the checkout the merge runs in is dirty');

  const merged = new Map();
  const shardSummaries = [];
  for (const [index, report] of [...byIndex].sort((a, b) => a[0] - b[0])) {
    const at = `shard ${String(index)}/${String(count)}`;
    const note = (text) => problems.push(`${at}: ${text}`);
    if (report.gate !== SABOTAGE_GATE) note(`gate is ${String(report.gate)}`);
    if (report.mode !== SHARD_MODE) note(`mode is ${String(report.mode)}, not ${SHARD_MODE}`);
    if (report.subject?.commit !== subject.commit) note(`commit ${String(report.subject?.commit)} is not the checkout's ${String(subject.commit)}`);
    if (report.subject?.tree !== subject.tree) note(`tree ${String(report.subject?.tree)} is not the checkout's ${String(subject.tree)}`);
    if (report.subject?.dirty !== false) note('produced on a dirty tree');
    if (!same(report.producers, current.producers)) note('producer hashes differ from the checkout');
    if (!same((report.inventory?.files ?? []).map((entry) => ({ file: entry.file, sha256: entry.sha256 })), filesNow)) note('inventory files differ from the checkout');
    if (!same(report.inventory?.ids, ids)) note('inventory ids differ from the checkout');
    if (report.inventoryDigest !== digest) note(`inventory digest ${String(report.inventoryDigest).slice(0, 12)} is not the checkout's ${digest.slice(0, 12)}`);
    if (!same((report.productionFiles ?? []).map((entry) => entry.file), productionNow)) note('production files recorded differ from the files the inventory mutates');
    if (report.baseline?.outcome !== 'SURVIVED') note(`baseline is ${String(report.baseline?.outcome)}`);
    // The merged report carries shard 1's production hashes and the final verifier checks those against the checkout;
    // every other shard must have run on byte-identical production files, or its kills say nothing about this tree (B04-R1).
    const firstProduction = byIndex.get(1)?.productionFiles;
    if (index !== 1 && firstProduction !== undefined && !same((report.productionFiles ?? []).map((entry) => ({ file: entry.file, sha256: entry.sha256 })), firstProduction.map((entry) => ({ file: entry.file, sha256: entry.sha256 })))) note('production file hashes differ from shard 1');

    // Records: exactly this shard's partition, each killed.
    const expected = mutations.filter((_, position) => position % count === index - 1);
    const records = Array.isArray(report.mutations) ? report.mutations : [];
    const recountShard = recount(records, expected.map((mutation) => mutation.id));
    for (const text of recountShard.problems) note(text);
    for (const id of recountShard.missing) note(`record for ${id} is missing`);
    if (records.length !== expected.length) note(`holds ${String(records.length)} records, its partition has ${String(expected.length)}`);
    for (const record of records) {
      const mutation = expected.find((entry) => entry.id === record.id);
      if (mutation === undefined) continue;
      if (record.file !== mutation.file || record.inventoryFile !== mutation.inventoryFile || record.gate !== mutation.gate) note(`record ${record.id} names ${String(record.inventoryFile)}/${String(record.file)}/${String(record.gate)}, the inventory names ${mutation.inventoryFile}/${mutation.file}/${String(mutation.gate)}`);
      if (record.outcome !== 'KILLED') note(`record ${String(record.id)} is ${String(record.outcome)}`);
      if (merged.has(record.id)) note(`record ${record.id} is also in another shard`);
      else merged.set(record.id, record);
    }
    for (const key of Object.keys(recountShard.counts)) if (report.counts?.[key] !== recountShard.counts[key]) note(`counts.${key} says ${String(report.counts?.[key])}, the records say ${String(recountShard.counts[key])}`);
    const killedAll = recountShard.problems.length === 0 && recountShard.missing.length === 0 && recountShard.counts.killed === expected.length && expected.length > 0;
    if (report.passed !== (killedAll && report.baseline?.outcome === 'SURVIVED')) note(`passed is ${String(report.passed)}, the records say ${String(killedAll)}`);
    if (report.qualifies !== false) note('a shard report must say qualifies:false');
    shardSummaries.push({ index, count, records: records.length, baseline: report.baseline?.outcome ?? null, jobs: report.jobs ?? null, node: report.node ?? null, startedAt: report.startedAt ?? null, finishedAt: report.finishedAt ?? null, reportSha256: sha256Of(JSON.stringify(report)) });
  }

  // Union: the inventory, exactly.
  for (const entry of ids) if (!merged.has(entry.id)) problems.push(`inventory id ${entry.id} is in no shard`);
  if (problems.length > 0) return { ok: false, problems, report: null };

  const records = ids.map((entry) => merged.get(entry.id));
  const first = byIndex.get(1);
  const { counts } = recount(records, ids.map((entry) => entry.id));
  const timestamps = shardSummaries.flatMap((entry) => [entry.startedAt, entry.finishedAt]).filter((value) => typeof value === 'string').sort();
  const report = {
    gate: SABOTAGE_GATE,
    mode: 'QUALIFICATION',
    qualifies: true,
    subject: { commit: subject.commit, tree: subject.tree, dirty: false, dirtyPaths: [], resolved: true },
    node: first.node,
    startedAt: timestamps[0] ?? null,
    finishedAt: timestamps[timestamps.length - 1] ?? null,
    inventory: { files: current.inventory.files, ids },
    producers: current.producers,
    productionFiles: first.productionFiles,
    jobs: first.jobs,
    baseline: first.baseline,
    merged: { from: SHARD_MODE, shards: count, inventoryDigest: digest, shardReports: shardSummaries },
    counts,
    mutations: records,
    passed: true,
  };
  return { ok: true, problems, report };
}

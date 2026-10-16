// The fixtures a campaign stage runs (B04 D4-CAMP-1, S042; Codex B04-R7), from the sealed partitions and nothing else:
//   smoke     one fixture per planted privacy channel the live suites audit (the first, in fixture-id order);
//   pilot     exactly the 60 PILOT fixtures: candidate selection never sees a FINAL fixture;
//   qualify   exactly the 600 FINAL fixtures: no pilot fixture counts toward a qualification rate;
//   rehearse  the whole sealed corpus (660), the offline rehearsal of the scorer and the transport.
// A partition short of its sealed size is refused, never topped up from the other. A development limit stays inside the partition.
import { LIVE_SUITES } from './live-audit.mjs';

export const PARTITION_SIZE = Object.freeze({ PILOT: 60, FINAL: 600 });

const spread = (entries, limit) => (limit === null ? entries : entries.filter((_, i) => i % Math.max(1, Math.floor(entries.length / limit)) === 0).slice(0, limit));

/**
 * @param {readonly any[]} fixtures the sealed corpus fixtures (any order)
 * @param {'smoke' | 'pilot' | 'qualify' | 'rehearse'} stage
 * @param {number | null} limit development only
 */
export function selectionOf(fixtures, stage, limit) {
  const sorted = [...fixtures].sort((a, b) => (a.fixture.fixtureId < b.fixture.fixtureId ? -1 : 1));
  if (stage === 'smoke') {
    const wanted = new Set(Object.values(LIVE_SUITES).flatMap((suite) => suite.tags));
    const seen = new Set();
    return sorted.filter((entry) => { const tag = (entry.structure.tags ?? []).find((candidate) => wanted.has(candidate)); if (tag === undefined || seen.has(tag)) return false; seen.add(tag); return true; });
  }
  if (stage === 'rehearse') return spread(sorted, limit);
  const partition = { pilot: 'PILOT', qualify: 'FINAL' }[stage];
  if (partition === undefined) throw new Error(`no selection for stage ${String(stage)}`);
  const own = sorted.filter((entry) => entry.partition === partition);
  if (own.length !== PARTITION_SIZE[partition]) throw new Error(`the sealed ${partition} partition holds ${String(own.length)} fixtures, not ${String(PARTITION_SIZE[partition])}: the ${stage} stage does not run`);
  return spread(own, limit);
}

// The staged part of the corpus: 648 fixtures, planted by the family templates, every structure distinct.
// 214 SUPPORTED + 109 AMBIGUOUS_ABSTENTION + 108 SAFETY + 108 ADVERSARIAL + 109 UGLY_MULTILINGUAL_STALE, beside the
// 12 sealed seed fixtures: 660 in all, 600 final + 60 pilot (D4-CORP-1).
import { fingerprintOf } from '../../dist/src/benchmark/corpus.js';
import { CAPS, MODES } from './lib.mjs';
import { seedTemplates } from './seed-templates.mjs';
import { AMBIGUOUS_KIND_COUNT, SAFETY_KIND_COUNT, ambiguousPlanted, safetyPlanted } from './boundary.mjs';
import { ADVERSARIAL_KIND_COUNT, UGLY_KIND_COUNT, adversarialPlanted, uglyPlanted } from './hard.mjs';
import { supportedPlanted } from './supported.mjs';

/** Draw planted facts until one has a structure no earlier fixture has; the attempt number only moves the random draw. */
export function distinct(make, used, label) {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    let planted;
    // A draw the planting rules reject as unreachable (lib.mjs, UNREACHABLE_DRAW) is drawn again, like a duplicate structure.
    try { planted = make(attempt); } catch (error) { if (error?.retry === true) { last = error; continue; } throw error; }
    const fingerprint = fingerprintOf({ structure: planted });
    if (!used.has(fingerprint)) { used.add(fingerprint); return planted; }
  }
  throw new Error(`no distinct reachable structure found for ${label}${last === null ? '' : `: ${last.message}`}`);
}

/** Each plan: the family, how many fixtures are staged, which of them are pilot, and how structure `index` is drawn. */
export const FAMILY_PLANS = [
  {
    family: 'SUPPORTED', prefix: 'sup', staged: 214, pilotFrom: 180, pilotCount: 20,
    cell: (index) => ({ capability: CAPS[index % 12], mode: MODES[Math.floor(index / 12) % 3], round: Math.floor(index / 36) }),
    make: (cell, attempt) => supportedPlanted(cell.capability, cell.mode, cell.round + 1000 * attempt),
    name: (cell) => `${cell.capability.toLowerCase()}-${cell.mode.toLowerCase().replace('_', '-')}`,
  },
  {
    family: 'AMBIGUOUS_ABSTENTION', prefix: 'amb', staged: 109, pilotFrom: 99, pilotCount: 10,
    cell: (index) => ({ kind: index % AMBIGUOUS_KIND_COUNT, mode: MODES[Math.floor(index / AMBIGUOUS_KIND_COUNT) % 3], round: Math.floor(index / (AMBIGUOUS_KIND_COUNT * 3)) }),
    make: (cell, attempt) => ambiguousPlanted(cell.kind, cell.mode, cell.round + 1000 * attempt),
    name: (cell) => `k${String(cell.kind).padStart(2, '0')}-${cell.mode.toLowerCase().replace('_', '-')}`,
  },
  {
    family: 'SAFETY', prefix: 'saf', staged: 108, pilotFrom: 98, pilotCount: 10,
    cell: (index) => ({ kind: index % SAFETY_KIND_COUNT, mode: MODES[Math.floor(index / SAFETY_KIND_COUNT) % 3], round: Math.floor(index / (SAFETY_KIND_COUNT * 3)) }),
    make: (cell, attempt) => safetyPlanted(cell.kind, cell.mode, cell.round + 1000 * attempt),
    name: (cell) => `k${String(cell.kind).padStart(2, '0')}-${cell.mode.toLowerCase().replace('_', '-')}`,
  },
  {
    family: 'ADVERSARIAL', prefix: 'adv', staged: 108, pilotFrom: 98, pilotCount: 10,
    cell: (index) => ({ kind: index % ADVERSARIAL_KIND_COUNT, mode: MODES[Math.floor(index / ADVERSARIAL_KIND_COUNT) % 3], round: Math.floor(index / (ADVERSARIAL_KIND_COUNT * 3)) }),
    make: (cell, attempt) => adversarialPlanted(cell.kind, cell.mode, cell.round + 1000 * attempt),
    name: (cell) => `k${String(cell.kind).padStart(2, '0')}-${cell.mode.toLowerCase().replace('_', '-')}`,
  },
  {
    family: 'UGLY_MULTILINGUAL_STALE', prefix: 'ugl', staged: 109, pilotFrom: 99, pilotCount: 10,
    cell: (index) => ({ kind: index % UGLY_KIND_COUNT, mode: MODES[Math.floor(index / UGLY_KIND_COUNT) % 3], round: Math.floor(index / (UGLY_KIND_COUNT * 3)) }),
    make: (cell, attempt) => uglyPlanted(cell.kind, cell.mode, cell.round + 1000 * attempt),
    name: (cell) => `k${String(cell.kind).padStart(2, '0')}-${cell.mode.toLowerCase().replace('_', '-')}`,
  },
];

export function stagedSet() {
  const used = new Set(seedTemplates.map(([, planted]) => fingerprintOf({ structure: planted })));
  const out = [];
  for (const plan of FAMILY_PLANS) {
    for (let index = 0; index < plan.staged; index += 1) {
      const cell = plan.cell(index);
      const planted = distinct((attempt) => plan.make(cell, attempt), used, `${plan.family} #${String(index)}`);
      const partition = index >= plan.pilotFrom && index < plan.pilotFrom + plan.pilotCount ? 'PILOT' : 'FINAL';
      out.push({ id: `fx-${plan.prefix}-${String(index).padStart(3, '0')}-${plan.name(cell)}`, partition, planted });
    }
  }
  return out;
}

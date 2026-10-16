#!/usr/bin/env node
// Corpus generator (B04-CORPUS, B04-FIXTURES). Builds the fixtures from the templates, binds every planted source to the
// real profile of the data plane (bind.mjs), writes truth from what the templates planted (never from a run of IC),
// draws fresh random canaries, and seals corpus/MANIFEST.json + MANIFEST.sha256 when it writes a sealed set.
// Run `npm run build` first: this reads the compiled framework from dist/.
//   node tools/corpus/generate.mjs [--out corpus] [--reseal]                 the 12 seed fixtures, sealed
//   node tools/corpus/generate.mjs --set staging [--out corpus]              the 648 staged fixtures into <out>/staging/fixtures, NOT sealed
//   node tools/corpus/generate.mjs --set full --reseal [--out corpus]        all 660 into <out>/fixtures, sealed (the operator's stage-merge step)
// An existing sealed corpus is refused unless --reseal is given (resealing draws new canaries).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFromPlanted, sealCorpus, corpusSetShortfall, corpusCoverageGaps } from '../../dist/src/benchmark/corpus.js';
import { bindPlanted } from './bind.mjs';
import { seedTemplates } from './seed-templates.mjs';
import { stagedSet } from './staged-set.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? fallback) : fallback; };
const out = resolve(repo, option('--out', 'corpus'));
const set = option('--set', 'seed');
const reseal = args.includes('--reseal');
if (!['seed', 'staging', 'full'].includes(set)) { process.stderr.write(`unknown --set ${set}\n`); process.exit(2); }
if (set !== 'staging' && existsSync(join(out, 'MANIFEST.json')) && !reseal) {
  process.stderr.write(`${out} is already sealed; pass --reseal to replace it with a freshly sealed corpus\n`);
  process.exit(2);
}

const canaries = () => [`kc_${randomBytes(12).toString('hex')}`, `kc_${randomBytes(12).toString('hex')}`];
const build = (id, partition, planted) => fixtureFromPlanted(planted, { fixtureId: id, partition, canaries: canaries(), binding: bindPlanted(planted) });
const seeds = () => seedTemplates.map(([id, planted]) => build(id, 'FINAL', planted));
const staged = () => stagedSet().map(({ id, partition, planted }) => build(id, partition, planted));
const write = (dir, fixtures) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const entry of fixtures) writeFileSync(join(dir, entry.fileName), `${JSON.stringify(entry, null, 2)}\n`);
};
const seal = (fixtures) => {
  const sealed = sealCorpus(fixtures);
  writeFileSync(join(out, 'MANIFEST.json'), sealed.manifestBytes);
  writeFileSync(join(out, 'MANIFEST.sha256'), `${sealed.manifestDigest}\n`);
  return sealed;
};

if (set === 'staging') {
  const fixtures = staged();
  write(join(out, 'staging', 'fixtures'), fixtures);
  process.stdout.write(`staged ${String(fixtures.length)} fixtures in ${join(out, 'staging', 'fixtures')} (not sealed)\n`);
} else if (set === 'seed') {
  const fixtures = seeds();
  write(join(out, 'fixtures'), fixtures);
  const sealed = seal(fixtures);
  process.stdout.write(`sealed ${String(fixtures.length)} fixtures, corpus digest ${sealed.manifest.corpusDigest}, manifest sha256 ${sealed.manifestDigest}\n`);
} else {
  const fixtures = [...seeds(), ...staged()];
  write(join(out, 'fixtures'), fixtures);
  rmSync(join(out, 'staging'), { recursive: true, force: true });
  const sealed = seal(fixtures);
  const short = [...corpusSetShortfall(sealed.manifest), ...corpusCoverageGaps(fixtures)];
  process.stdout.write(`sealed ${String(fixtures.length)} fixtures, corpus digest ${sealed.manifest.corpusDigest}, manifest sha256 ${sealed.manifestDigest}${short.length === 0 ? '' : `\nSHORT: ${short.join('; ')}`}\n`);
  if (short.length > 0) process.exit(1);
}

#!/usr/bin/env node
/**
 * Seal a campaign over the tree as it stands.
 *
 * Run once, on a clean tree, immediately before the campaign: everything
 * produced afterwards records this campaign id and this subject digest, and a
 * gate refuses evidence that names another. Re-sealing is deliberate and
 * visible — the id changes, so every piece of evidence from the previous
 * campaign stops matching and has to be produced again.
 *
 *   node tools/seal-campaign.mjs [--at <ISO-8601 UTC instant>] [--check]
 *
 * `--check` prints the campaign this tree is under and whether the subject
 * still matches it, and writes nothing.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { measureSubject } from './execution-subject.mjs';
import { measureProducers } from './producer-closure.mjs';
import { readCampaign, sealCampaign } from '../qualification/campaign.mjs';
import { repoRoot } from './candidate-provenance.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`${flag} needs a value\n`);
    process.exit(64);
  }
  return value;
};

const check = args.includes('--check');
const at = valueOf('--at');
for (const arg of args) {
  if (arg !== '--check' && arg !== '--at' && arg !== at) {
    process.stderr.write(`unknown option ${arg}\n`);
    process.exit(64);
  }
}
if (at !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(at)) {
  process.stderr.write(`--at ${at} is not an ISO-8601 UTC instant to the second\n`);
  process.exit(64);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { subject, subjectDigest, problems } = await measureSubject();
  if (subject === null) {
    process.stderr.write(`the execution subject could not be measured:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exit(1);
  }

  if (check) {
    const campaign = readCampaign();
    if (campaign === null) {
      process.stderr.write('no campaign is sealed\n');
      process.exit(1);
    }
    // Per producer. The whole-subject digest is still printed for a reader, but
    // what decides "matches" is whether every producer the campaign sealed still
    // fingerprints the same over this tree — and which ones do not.
    //
    // The universe is sealed for the record and not for the binding. It takes
    // no capture: it binds through the manifest and code digests its report
    // records, which the release gate compares against the tree it judges, and
    // it runs last, after every other harness change. Holding the campaign to
    // the universe's whole-subject fingerprint would refuse the campaign the
    // moment any tool changed, which is the whole-subject binding by another
    // name; it is reported here beside the binding, not inside it.
    const producers = await measureProducers();
    const sealed = campaign.producers ?? {};
    const binding = Object.entries(sealed).filter(([, entry]) => entry?.kind !== 'UNIVERSE');
    const moved = binding.filter(([producer, entry]) => producers.fingerprints[producer] !== entry?.fingerprint).map(([producer]) => producer);
    const universeMoved = Object.entries(sealed)
      .filter(([, entry]) => entry?.kind === 'UNIVERSE')
      .filter(([producer, entry]) => producers.fingerprints[producer] !== entry?.fingerprint)
      .map(([producer]) => producer);
    const same = binding.length > 0 && producers.problems.length === 0 && moved.length === 0;
    process.stdout.write(
      `${JSON.stringify(
        {
          campaignId: campaign.campaignId,
          sealedAt: campaign.sealedAt,
          subjectDigest: campaign.subjectDigest,
          treeSubjectDigest: subjectDigest,
          subjectMatches: campaign.subjectDigest === subjectDigest,
          producersSealed: Object.keys(sealed).length,
          producersBinding: binding.length,
          producersMoved: moved,
          subjectMovedSinceSeal: universeMoved,
          matches: same,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(same ? 0 : 1);
  }

  // A campaign names a tree somebody else can check out. Sealing over
  // uncommitted bytes would name a subject that exists on one machine.
  const status = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = (status.stdout ?? '').split('\n').filter((line) => line.trim() !== '');
  if (status.status !== 0 || dirty.length > 0) {
    process.stderr.write(
      `refusing to seal: the working tree is not clean (${String(dirty.length)} paths).\n` +
        'A campaign names a subject other people have to be able to check out; sealing over uncommitted bytes names one that exists here only.\n' +
        `${dirty.slice(0, 10).map((line) => `  ${line}`).join('\n')}\n`,
    );
    process.exit(1);
  }

  const campaign = await sealCampaign(at === null ? {} : { sealedAt: at });
  process.stderr.write(
    `sealed campaign ${campaign.campaignId} at ${campaign.sealedAt}\n` +
      `subject ${campaign.subjectDigest}\n` +
      `code    ${campaign.codeDigest}\n` +
      `${String(Object.values(campaign.classes).filter((entry) => entry.inSubject).reduce((total, entry) => total + entry.files, 0))} files in the subject, ` +
      `${String(campaign.dependencies.packageCount)} packages in the dependency closure\n`,
  );
  process.stdout.write(`${JSON.stringify(campaign, null, 2)}\n`);
}

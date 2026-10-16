#!/usr/bin/env node
// The exact reservation of a campaign stage from the sealed corpus (B04-QUALIFY, B04-campaign-envelope §3/§5/§6).
// First-attempt request bytes are deterministic per fixture: each fixture is run through the public core behind the SIMULATED
// truth-following transport (no network, no paid inference) and the byte length of every Vertex body the core sends is counted,
// exactly as the Vertex transport would serialise it. Only repairs, output and tokens per byte stay estimates (named in the output).
// Run `npm run build` first. This is arithmetic over the corpus, never qualification evidence.
//   node tools/campaign/envelope.mjs [--corpus corpus] [--limit N] [--out <envelope.json>]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPUS_5_5_US, SONNET_5_5_US, sealedObject, truthFollowingAnswer, verifyCorpus } from 'kauro-intelligence-core/benchmark';
import { campaignEnvelopes, requestBytesOfFixtures } from './envelope-lib.mjs';
import { loadCorpus } from './validity-run.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? fallback) : fallback; };

const corpusDir = resolve(repo, option('--corpus', 'corpus'));
const corpus = loadCorpus(corpusDir);
const problems = verifyCorpus(corpus.manifest, corpus.fixtures);
if (problems.length > 0) { process.stderr.write(`the corpus in ${corpusDir} is not what its manifest sealed:\n  ${problems.slice(0, 10).join('\n  ')}\n`); process.exit(2); }
const limit = Number(option('--limit', String(corpus.fixtures.length)));
const chosen = corpus.fixtures.slice(0, limit);

const perFixture = await requestBytesOfFixtures(chosen, { truthFollowingAnswer, sealedObject, onProgress: (done, total) => { if (done % 50 === 0 || done === total) process.stderr.write(`  ${String(done)}/${String(total)} fixtures measured\n`); } });
const record = { evidenceClass: 'SIMULATED', note: 'arithmetic over the sealed corpus bytes; not qualification evidence', corpusDigest: corpus.manifest.corpusDigest, fixturesMeasured: chosen.length, ...campaignEnvelopes(perFixture, [SONNET_5_5_US, OPUS_5_5_US]) };
const out = option('--out', null);
if (out !== null) writeFileSync(resolve(repo, out), `${JSON.stringify(record, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

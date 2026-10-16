// Offline proven, never declared (B04 D4-CAMP-8; Codex re-check of B04-R3). A run the core decided without the model carries no
// provider exchange, so nothing on the wire substantiates it; what does is determinism: the same sealed fixture, replayed through
// the same public core with a transport that refuses every send, is decided with zero requests. replayOffline returns the fixtures
// replayed and those decided offline; qualifyCampaignRuns hands that to qualifyThreeRuns, which refuses a declared offline fixture
// the replay did not cover or saw send, and a fixture the replay decided offline that carries exchanges. No network.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qualifyThreeRuns, sealedObject, verifyCorpus } from 'kauro-intelligence-core/benchmark';
import { loadCorpus, materialise, runThroughPublicCore } from './validity-run.mjs';

/** The object the host declares beside the source, as the runner does (stage-child.mjs). */
export const declaredObjectOf = (entry) => (entry.structure.project !== undefined ? entry.structure.project.object : entry.fixture.expectedTaskTypes.includes('OBJECT_MAPPING') ? null : sealedObject(entry.fixture));

/**
 * Replays each sealed fixture through the public core with a transport that refuses every send.
 * @param {readonly any[]} corpusFixtures sealed corpus fixtures
 * @returns {Promise<{ replayed: string[], offline: string[] }>}
 */
export async function replayOffline(corpusFixtures) {
  const replayed = [];
  const offline = [];
  for (const entry of corpusFixtures) {
    const bundle = materialise(entry, { declaredObject: declaredObjectOf(entry) });
    let sends = 0;
    try {
      await runThroughPublicCore(bundle, () => { throw new Error('the offline replay answers nothing'); }, `offline-replay-${entry.fixture.fixtureId}`, () => { sends += 1; throw new Error('the offline replay refuses every send'); });
    } catch {
      // A run that ends in an error without a send was not decided by the core: it is not proven offline.
      if (sends === 0) sends = -1;
    } finally {
      bundle.dispose();
    }
    replayed.push(entry.fixture.fixtureId);
    if (sends === 0) offline.push(entry.fixture.fixtureId);
  }
  return { replayed: replayed.sort(), offline: offline.sort() };
}

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));

/**
 * The qualification of three run directories (run-record.json and the full receipts.jsonl each) over the sealed corpus: every
 * fixture the records name is replayed from the sealed corpus (never from the run's own selection file) before the verdict.
 * @param {{ runDirs: readonly string[], corpusDir: string }} options
 */
export async function qualifyCampaignRuns({ runDirs, corpusDir }) {
  const corpus = loadCorpus(corpusDir);
  const sealProblems = verifyCorpus(corpus.manifest, corpus.fixtures);
  if (sealProblems.length > 0) throw new Error(`the corpus is not what its manifest sealed: ${sealProblems.slice(0, 3).join('; ')}`);
  const records = runDirs.map((dir) => JSON.parse(readFileSync(join(dir, 'run-record.json'), 'utf8')));
  const receipts = runDirs.map((dir) => (existsSync(join(dir, 'receipts.jsonl')) ? readJsonl(join(dir, 'receipts.jsonl')) : []));
  const named = new Set(records.flatMap((record) => (Array.isArray(record.runFixtures) ? record.runFixtures : []).map((one) => one.fixtureId)));
  const sealed = corpus.fixtures.filter((entry) => named.has(entry.fixture.fixtureId));
  const replay = await replayOffline(sealed);
  return { qualification: qualifyThreeRuns(records, receipts, replay), replay };
}

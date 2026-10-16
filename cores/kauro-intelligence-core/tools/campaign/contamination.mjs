// The funded runner's contamination guard (B04 D4-CAMP-7; R2-040; Codex B04-R4). It is the package's guard
// (`createContaminationGuard`, the whole-manifest scan of every truth canary and every corpus file name) put where the money is:
//   - the runner hands `beforeSend` to the Vertex transport, which calls it with the exact bytes of each physical request after the
//     preflight and before the token, the receipt and the fetch; a hit refuses that request BEFORE_SEND (nothing is written);
//   - on a hit the corpus is latched on disk (the corpus digest, the fixtures and the token digests; never the token), the campaign
//     is stopped (onHit), and every later request of the invocation is refused;
//   - a latch for the sealed corpus digest refuses every new invocation (preflight and runner) until the corpus is resealed, which
//     changes its digest. A latch for another digest is a resealed corpus's past and refuses nothing.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createContaminationGuard } from 'kauro-intelligence-core/benchmark';

/** The refusal a latch on disk makes for this corpus digest, or null. An unreadable latch refuses too: it may be a hit. */
export function latchedCorpus(latchPath, corpusDigest) {
  if (!existsSync(latchPath)) return null;
  let latch;
  try { latch = JSON.parse(readFileSync(latchPath, 'utf8')); } catch { return { code: 'CORPUS_CONTAMINATED', detail: `${latchPath} is not readable: it is taken as a contamination latch until the owner inspects it` }; }
  if (latch?.corpusDigest !== corpusDigest) return null;
  return { code: 'CORPUS_CONTAMINATED', detail: `the sealed corpus ${corpusDigest.slice(0, 12)}… was contaminated (fixtures ${(latch.invalidatedFixtures ?? []).slice(0, 5).join(', ')}): reseal it before any further funded dispatch` };
}

function writeLatch(latchPath, record) {
  mkdirSync(dirname(latchPath), { recursive: true });
  const fd = openSync(latchPath, 'w');
  try { writeSync(fd, `${JSON.stringify(record, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * @param {{ manifest: { corpusDigest: string, fixtures: unknown[] }, latchPath: string, onHit: (reason: 'CANARY_HIT') => void }} options
 * @returns {{ beforeSend: (fixtureId: string, bytes: string) => void, readonly scanned: number, readonly hits: number }}
 */
export function fundedContaminationGuard({ manifest, latchPath, onHit }) {
  const guard = createContaminationGuard(manifest);
  let scanned = 0;
  let hits = 0;
  let latched = latchedCorpus(latchPath, manifest.corpusDigest);
  return {
    beforeSend(fixtureId, bytes) {
      if (latched !== null) throw new Error(`corpus contamination latched: ${latched.detail}`);
      guard.assertMayDispatch();
      scanned += 1;
      const verdict = guard.checkRequestReceipt(fixtureId, bytes);
      if (verdict.hits.length === 0) return;
      hits += 1;
      const record = { corpusDigest: manifest.corpusDigest, at: new Date().toISOString(), fixtureId, invalidatedFixtures: guard.invalidatedFixtures(), hits: verdict.hits };
      writeLatch(latchPath, record);
      latched = { code: 'CORPUS_CONTAMINATED', detail: `request of ${fixtureId} carried ${verdict.hits.map((hit) => `${hit.kind} of ${hit.fixtureId}`).join(', ')}` };
      onHit('CANARY_HIT');
      throw new Error(`corpus contamination: ${latched.detail}; reseal the corpus before any further funded dispatch`);
    },
    get scanned() { return scanned; },
    get hits() { return hits; },
  };
}

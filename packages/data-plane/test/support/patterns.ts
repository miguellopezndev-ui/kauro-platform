// Deterministic byte patterns for the corpus: blocks of 64 KiB that begin with pseudo-random bytes and continue with zeros, so a
// part compresses about 100:1 (well inside the compression-ratio bound of the inspection) and its content is known to the test.

/** `total` bytes of 64 KiB blocks, each starting with `randomPerBlock` pseudo-random bytes (seeded; the rest zeros). */
export function patternedBytes(total: number, randomPerBlock = 600, seed = 7): Buffer {
  const out = Buffer.alloc(total);
  let state = seed >>> 0;
  for (let block = 0; block < total; block += 65_536) {
    const end = Math.min(total, block + randomPerBlock);
    for (let i = block; i < end; i++) {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      out[i] = state >>> 24;
    }
  }
  return out;
}

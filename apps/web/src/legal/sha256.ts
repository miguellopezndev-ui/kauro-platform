// SHA-256 (FIPS 180-4) over the UTF-8 bytes of a string, synchronous and free of any runtime module. The version label of a legal document
// (render.ts) is built from a digest of its text, and this package's sources sit where a browser bundle could reach them: the architecture
// gate refuses a Node built-in there (node:crypto, D-SEC-2) and Web Crypto answers asynchronously, which would make every renderer call
// asynchronous for a value that is a pure function of the text. test/legal-digest.test.ts holds this function equal to node:crypto on the
// published test vectors and on every length around the padding boundaries, so a slip in a constant or a rotation cannot ship.
//
// The constants are derived, not typed: the round constants are the first 32 bits of the fractional parts of the cube roots of the first 64
// primes, and the initial state is the same for the square roots of the first 8 (FIPS 180-4, 4.2.2 and 5.3.3). The test vectors verify them.

function firstPrimes(count: number): readonly number[] {
  const found: number[] = [];
  for (let candidate = 2; found.length < count; candidate += 1) if (found.every((prime) => candidate % prime !== 0)) found.push(candidate);
  return found;
}

const fraction32 = (value: number): number => Math.floor((value - Math.floor(value)) * 4294967296);
const PRIMES = firstPrimes(64);
const ROUND_CONSTANTS = Uint32Array.from(PRIMES.map((prime) => fraction32(Math.cbrt(prime))));
const INITIAL_STATE = Uint32Array.from(PRIMES.slice(0, 8).map((prime) => fraction32(Math.sqrt(prime))));

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
const word = (words: Uint32Array, index: number): number => words[index] ?? 0;

/** The message split into 64-byte blocks: the bytes, one 0x80 byte, zeros, and the bit length as a 64-bit big-endian number. */
function padded(text: string): DataView {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const block = new Uint8Array(size);
  block.set(bytes);
  block[bytes.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(size - 4, (bytes.length * 8) % 4294967296);
  return view;
}

/** The SHA-256 digest of the UTF-8 encoding of `text`, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  const view = padded(text);
  const state = Uint32Array.from(INITIAL_STATE);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const early = word(schedule, index - 15);
      const late = word(schedule, index - 2);
      const small0 = rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3);
      const small1 = rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10);
      schedule[index] = (word(schedule, index - 16) + small0 + word(schedule, index - 7) + small1) >>> 0;
    }
    let a = word(state, 0);
    let b = word(state, 1);
    let c = word(state, 2);
    let d = word(state, 3);
    let e = word(state, 4);
    let f = word(state, 5);
    let g = word(state, 6);
    let h = word(state, 7);
    for (let round = 0; round < 64; round += 1) {
      const big1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + big1 + choose + word(ROUND_CONSTANTS, round) + word(schedule, round)) >>> 0;
      const big0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (big0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    next.forEach((value, index) => {
      state[index] = (word(state, index) + value) >>> 0;
    });
  }
  return Array.from(state, (value) => value.toString(16).padStart(8, "0")).join("");
}

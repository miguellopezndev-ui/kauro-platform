import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return hash.digest('hex');
}

/** Short, collision-checked identifier prefix used in locators. Full hashes are always retained alongside. */
export function shortHash(fullHex: string, length = 12): string {
  return fullHex.slice(0, length);
}

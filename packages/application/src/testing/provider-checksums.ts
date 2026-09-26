/**
 * The checksums a storage provider reports for an object (Cloud Storage: CRC32C, big-endian, and MD5, each base64). They are
 * provider evidence, never a substitute for the server's own SHA-256 (ObjectObservation). The labelled contract fake of object
 * storage reports them exactly as the provider documents them, so a consumer that compares a claim with an observation compares
 * the same encodings it will meet at the real provider (B15).
 */
import { createHash } from "node:crypto";

/** CRC-32C (Castagnoli, reflected polynomial 0x82F63B78), the table built once. */
const CRC32C_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32C of the bytes as an unsigned 32-bit integer (check value of "123456789": 0xE3069283). */
export function crc32cOf(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC32C_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The provider checksums of an object: CRC32C (4 bytes, big-endian) and MD5 (16 bytes), each base64 as the provider reports them. */
export function providerChecksumsOf(bytes: Uint8Array): { readonly crc32c: string; readonly md5: string } {
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32cOf(bytes), false);
  return {
    crc32c: Buffer.from(crc).toString("base64"),
    md5: createHash("md5").update(bytes).digest("base64"),
  };
}

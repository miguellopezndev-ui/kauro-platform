/**
 * Id generator port (07 "Database representation": server-generated UUIDv7). The adapter supplies entropy and the clock;
 * the encoding is the domain's (model/ids.ts). A generator is monotonic within one process: two ids minted in the same
 * millisecond still sort in minting order (RFC 9562 §6.2 counter in rand_a), which keeps index locality without ever being
 * used as business ordering.
 */
import type { Id } from "@kauro/contracts";
import { encodeUuidV7 } from "../model/ids.js";
import type { Clock } from "./clock.js";

export interface IdGenerator {
  /** A fresh UUIDv7. Callers brand it (e.g. `as AgencyId`) at the point where they know what it identifies. */
  next(): Id;
}

/** Entropy source: returns `n` cryptographically random bytes (adapters bind node:crypto.randomBytes). */
export type RandomBytes = (n: number) => Uint8Array;

/**
 * Reference implementation of the port over a clock and an entropy source. Within one millisecond the 12-bit rand_a field
 * acts as a counter seeded randomly, so ids stay monotonic; when the counter would overflow, the generator waits for the next
 * millisecond by advancing the timestamp (the RFC-permitted "counter rollover" handling).
 */
export function createIdGenerator(clock: Clock, random: RandomBytes): IdGenerator {
  let lastMs = -1;
  let counter = 0;
  return {
    next(): Id {
      let ms = clock.nowMs();
      const bytes = random(10);
      if (ms <= lastMs) {
        ms = lastMs;
        counter += 1;
        if (counter > 0x0fff) {
          ms = lastMs + 1;
          counter = ((bytes[0] as number) << 8 | (bytes[1] as number)) & 0x0fff;
        }
      } else {
        counter = ((bytes[0] as number) << 8 | (bytes[1] as number)) & 0x0fff;
      }
      lastMs = ms;
      bytes[0] = (counter >> 8) & 0x0f;
      bytes[1] = counter & 0xff;
      return encodeUuidV7(ms, bytes);
    },
  };
}

/**
 * Account recovery by recovery codes (O23A; NIST SP 800-63B §5.1.2 look-up secrets, ASVS 4.0.3 V2.6, V2.5.6): ten single-use codes
 * of 50 bits each, shown once, stored only as HMAC-SHA256 under a server pepper and bound to the person. A redemption is
 * abuse-limited per account and network; a wrong, used or unknown code is the same REFUSED answer. A successful redemption ends
 * every session of the person (a recovery is a credential change) and requires the second factor to be enrolled again;
 * regenerating the codes replaces every earlier one.
 */
import { createHmac } from "node:crypto";
import type { UtcInstant } from "@kauro/contracts";
import type { Clock, RandomBytes, UserId } from "@kauro/domain";
import type { AbuseKeys, AbuseLimiter } from "./abuse.js";
import type { PersonSessionRevoker } from "./revocation.js";

export const RECOVERY_CODE_COUNT = 10;
/** Crockford base32: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

/** The vault of recovery-code digests (the boundary's store; in-memory in @kauro/identity/testing). */
export interface RecoveryCodeVault {
  /** Replaces every code of the person with these digests. */
  replace(userId: UserId, digests: ReadonlyArray<string>, at: UtcInstant): Promise<void>;
  /** Marks the digest used, once: CONSUMED only for an unused digest of that person. */
  consume(userId: UserId, digest: string, at: UtcInstant): Promise<"CONSUMED" | "UNKNOWN">;
  remaining(userId: UserId): Promise<number>;
}

/** A code as typed: uppercase, spaces and hyphens dropped, the usual confusions mapped (O to 0, I and L to 1). */
export function normaliseRecoveryCode(typed: string): string | null {
  const raw = typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (raw.length !== 10) return null;
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  return CODE_SHAPE.test(code) ? code : null;
}

/** HMAC-SHA256 under the pepper, bound to the person: the same code of two people is two digests. */
export function recoveryCodeDigest(pepper: Uint8Array, userId: UserId, code: string): string {
  return createHmac("sha256", pepper).update(`kauro-recovery-v1\u0000${userId}\u0000${code}`, "utf8").digest("hex");
}

export function mintRecoveryCodes(random: RandomBytes): ReadonlyArray<string> {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    const bytes = random(10);
    if (bytes.byteLength !== 10) throw new RangeError("the entropy source returned the wrong number of bytes");
    // 10 characters of 5 bits from the low bits of 10 random bytes (no modulo bias: 32 divides 256)
    const chars = [...bytes].map((b) => ALPHABET[b & 31]).join("");
    codes.add(`${chars.slice(0, 5)}-${chars.slice(5)}`);
  }
  return [...codes];
}

export type RecoveryOutcome =
  | { readonly kind: "RECOVERED"; readonly remaining: number; readonly sessionsEnded: number; readonly mfaReenrollmentRequired: true }
  | { readonly kind: "REFUSED" }
  | { readonly kind: "LIMITED"; readonly retryAfterSeconds: number };

export interface RecoveryServiceDependencies {
  readonly vault: RecoveryCodeVault;
  readonly limiter: AbuseLimiter;
  readonly revoker: PersonSessionRevoker;
  readonly clock: Clock;
  readonly random: RandomBytes;
  /** The server pepper (at least 32 bytes; a secret of the deployment, never in source). */
  readonly pepper: Uint8Array;
}

export interface RecoveryService {
  /** New codes for the person (the caller has required a fresh step-up: RECOVERY_CODES_REGENERATE). Shown once. */
  regenerate(userId: UserId): Promise<ReadonlyArray<string>>;
  redeem(userId: UserId, typed: string, network: string | null): Promise<RecoveryOutcome>;
}

export function createRecoveryService(deps: RecoveryServiceDependencies): RecoveryService {
  if (deps.pepper.byteLength < 32) throw new RangeError("the recovery pepper is at least 32 bytes");
  return {
    async regenerate(userId) {
      const codes = mintRecoveryCodes(deps.random);
      await deps.vault.replace(userId, codes.map((c) => recoveryCodeDigest(deps.pepper, userId, c)), deps.clock.now());
      return codes;
    },
    async redeem(userId, typed, network) {
      const keys: AbuseKeys = { account: userId, network };
      const gate = deps.limiter.attempt("RECOVERY_CODE", keys);
      if (gate.kind === "LIMITED") return gate;
      try {
        const code = normaliseRecoveryCode(typed);
        const consumed = code === null ? "UNKNOWN" : await deps.vault.consume(userId, recoveryCodeDigest(deps.pepper, userId, code), deps.clock.now());
        if (consumed !== "CONSUMED") {
          gate.attempt.fail();
          return { kind: "REFUSED" };
        }
        gate.attempt.succeed();
      } finally {
        // anything that threw (a vault, or a code that is not a string) ends the attempt without counting it; an ended attempt
        // ignores this (O23A2 review m1: a held place never expires)
        gate.attempt.release();
      }
      const sessionsEnded = await deps.revoker.revokeAllOf(userId, () => deps.clock.now(), "RECOVERY");
      return { kind: "RECOVERED", remaining: await deps.vault.remaining(userId), sessionsEnded, mfaReenrollmentRequired: true };
    },
  };
}

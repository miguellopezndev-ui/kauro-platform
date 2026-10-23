/**
 * E-mail verification challenges (O23A; ASVS 4.0.3 V2.5, NIST SP 800-63B §5.1.3 out-of-band): the provider proves the sign-in
 * e-mail (the session boundary refuses EMAIL_NOT_VERIFIED); Kauro proves an address it is asked to adopt (a changed account
 * e-mail, a notification address) before it uses it.
 *
 *  - a challenge is 32 random bytes (base64url, 43 characters) sent to the address through the outbox port (offline: captured,
 *    never delivered); only its SHA-256 is stored, with the person, the normalised address and an expiry of 24 hours;
 *  - a new challenge of the same person supersedes the earlier one; a confirmation is single-use and only by the person who asked:
 *    a wrong, expired, used, superseded or foreign token is one REFUSED answer;
 *  - sends and confirmations are abuse-limited.
 */
import { createHash } from "node:crypto";
import type { UtcInstant } from "@kauro/contracts";
import type { Clock, RandomBytes, UserId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import type { AbuseLimiter } from "./abuse.js";

export const EMAIL_CHALLENGE_TTL_SECONDS = 86_400;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

export interface EmailChallengeRecord {
  readonly userId: UserId;
  readonly email: string;
  readonly tokenSha256: string;
  readonly expiresAt: UtcInstant;
  readonly confirmedAt: UtcInstant | null;
}

export interface EmailChallengeStore {
  /** Records the challenge as the person's only open one (an earlier one is superseded). */
  put(record: EmailChallengeRecord): Promise<void>;
  /** The person's current challenge, if any. */
  open(userId: UserId): Promise<EmailChallengeRecord | null>;
  /** Marks the person's challenge of this hash confirmed, once: true only the first time. */
  confirm(userId: UserId, tokenSha256: string, at: UtcInstant): Promise<boolean>;
}

/** Where a challenge goes out (offline: a captured message; live delivery is the notification provider's, O23B). */
export interface EmailOutbox {
  send(message: { readonly to: string; readonly kind: "EMAIL_VERIFICATION"; readonly token: string; readonly expiresAt: UtcInstant }): Promise<void>;
}

export function normaliseEmail(email: string): string | null {
  const value = email.trim().normalize("NFKC");
  if (!EMAIL_SHAPE.test(value)) return null;
  const at = value.lastIndexOf("@");
  // the domain is case-insensitive; the local part is kept as typed (RFC 5321 §2.4)
  return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export type ChallengeSend = { readonly kind: "SENT"; readonly expiresAt: UtcInstant } | { readonly kind: "INVALID_EMAIL" } | { readonly kind: "LIMITED"; readonly retryAfterSeconds: number };
export type ChallengeConfirm = { readonly kind: "VERIFIED"; readonly email: string } | { readonly kind: "REFUSED" } | { readonly kind: "LIMITED"; readonly retryAfterSeconds: number };

export interface EmailVerification {
  send(userId: UserId, email: string, network: string | null): Promise<ChallengeSend>;
  confirm(userId: UserId, token: string, network: string | null): Promise<ChallengeConfirm>;
}

export interface EmailVerificationDependencies {
  readonly store: EmailChallengeStore;
  readonly outbox: EmailOutbox;
  readonly limiter: AbuseLimiter;
  readonly clock: Clock;
  readonly random: RandomBytes;
}

export function createEmailVerification(deps: EmailVerificationDependencies): EmailVerification {
  return {
    async send(userId, email, network) {
      const address = normaliseEmail(email);
      if (address === null) return { kind: "INVALID_EMAIL" };
      const keys = { account: userId, network };
      const gate = deps.limiter.attempt("EMAIL_CHALLENGE_SEND", keys);
      if (gate.kind === "LIMITED") return gate;
      // every send counts: the limit is on messages, not on failures
      gate.attempt.fail();
      const bytes = deps.random(32);
      if (bytes.byteLength !== 32) throw new RangeError("the entropy source returned the wrong number of bytes");
      const token = Buffer.from(bytes).toString("base64url");
      const expiresAt = toUtcInstant(deps.clock.nowMs() + EMAIL_CHALLENGE_TTL_SECONDS * 1000);
      await deps.store.put({ userId, email: address, tokenSha256: sha256(token), expiresAt, confirmedAt: null });
      await deps.outbox.send({ to: address, kind: "EMAIL_VERIFICATION", token, expiresAt });
      return { kind: "SENT", expiresAt };
    },
    async confirm(userId, token, network) {
      const keys = { account: userId, network };
      const gate = deps.limiter.attempt("EMAIL_CHALLENGE_CONFIRM", keys);
      if (gate.kind === "LIMITED") return gate;
      const refuse = (): ChallengeConfirm => {
        gate.attempt.fail();
        return { kind: "REFUSED" };
      };
      try {
        if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return refuse();
        const open = await deps.store.open(userId);
        const digest = sha256(token);
        if (open === null || open.tokenSha256 !== digest || open.confirmedAt !== null) return refuse();
        const now = deps.clock.now();
        if (Date.parse(now) >= Date.parse(open.expiresAt)) return refuse();
        if (!(await deps.store.confirm(userId, digest, now))) return refuse();
        gate.attempt.succeed();
        return { kind: "VERIFIED", email: open.email };
      } finally {
        // a store that threw ends the attempt without counting it; an ended attempt ignores this
        gate.attempt.release();
      }
    },
  };
}

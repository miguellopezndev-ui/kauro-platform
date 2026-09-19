/**
 * Authentication at the HTTP edge (08 "Identity is not permission": authentication produces an identity reference and
 * assurance facts; nothing more). The Authenticator turns request headers into an AuthenticatedSubject or null; the API then
 * resolves membership and capability server-side per command. The provider subject never leaves this module: the platform
 * carries only the derived UUIDv5 user id and the SHA-256 of the subject.
 *
 * `createBearerTokenAuthenticator` binds opaque bearer tokens to subjects for the LOCAL environment and for tests; the
 * Identity Platform token verifier (issuer, audience, signature, MFA and email claims) is the identity package's adapter and
 * implements this same interface.
 */
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AuthenticatedSubject } from "@kauro/application";
import { identityUserId } from "@kauro/domain";

export interface Authenticator {
  authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<AuthenticatedSubject | null>;
}

export interface SubjectFacts {
  readonly provider: string;
  readonly subject: string;
  readonly emailVerifiedAt: UtcInstant | null;
  readonly mfaEnrolledAt: UtcInstant | null;
  readonly state: "ACTIVE" | "DISABLED";
}

/** Derives the platform's view of an authenticated person from the provider facts. */
export function subjectOf(facts: SubjectFacts): AuthenticatedSubject {
  return {
    identity: {
      userId: identityUserId(facts.provider, facts.subject),
      emailVerifiedAt: facts.emailVerifiedAt,
      mfaEnrolledAt: facts.mfaEnrolledAt,
      state: facts.state,
    },
    provider: facts.provider,
    subjectHash: createHash("sha256").update(facts.subject, "utf8").digest("hex") as Sha256Hex,
  };
}

const BEARER = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,512})$/;

export function createBearerTokenAuthenticator(tokens: ReadonlyMap<string, AuthenticatedSubject>): Authenticator {
  return {
    async authenticate(headers) {
      const value = headers["authorization"];
      if (value === undefined) return null;
      const m = BEARER.exec(value);
      if (!m) return null;
      return tokens.get(m[1] as string) ?? null;
    },
  };
}

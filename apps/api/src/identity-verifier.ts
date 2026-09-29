/**
 * The api's verification of identity tokens (B11 design D-AUTH-3; 08 "Identity is not permission": authentication produces an
 * identity reference and assurance facts). The IdentityTokenVerifier port of @kauro/application, over `jose` 6.2.12 (D-STACK-1):
 *
 *   header   alg RS256 only (none, HS*, RS384/512, ES* are refused before any key is touched); kid names a key of the source
 *   signature RSASSA-PKCS1-v1_5 SHA-256 by that key
 *   iss      https://securetoken.google.com/<project>;  aud  <project>
 *   exp      in the future (no tolerance); iat and auth_time in the past, with 30 s of clock skew
 *   sub      1..128 characters (and user_id, when present, the same)
 *   email_verified  a boolean (absent: false);  firebase.sign_in_second_factor  a string or absent
 *
 * Every defect is REJECTED with its name (diagnostics and tests only; the wire answer is the one 401 IDENTITY_TOKEN_INVALID).
 * A key source that cannot be read is UNAVAILABLE (the route answers a retryable 503: the caller's credentials were not judged).
 *
 * Key sources — the same verifier code for both:
 *  - GOOGLE_X509: Google's securetoken document (https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com),
 *    a JSON object of kid → PEM X.509 certificate, cached for the Cache-Control max-age of the answer (Firebase "Verify ID tokens
 *    using a third-party JWT library"); a kid the cached document does not name refreshes it, at most once a minute (key
 *    rotation). Live qualification of this source is B15's; this package proves it against the documented format.
 *  - CONTRACT_FAKE: the JWKS of the contract-fake issuer (@kauro/application/testing, SIMULATED), accepted in LOCAL only: the
 *    verifier refuses to be built with it in any other environment, and the configuration refuses it by name.
 */
import { X509Certificate, createPublicKey, type KeyObject } from "node:crypto";
import { decodeProtectedHeader, errors, jwtVerify } from "jose";
import type { IdentityTokenDefect, IdentityTokenVerification, IdentityTokenVerifier } from "@kauro/application";
import { SESSION_POLICY } from "@kauro/application";
import type { Clock, Environment } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";

/** Google's documented securetoken certificate document. */
export const GOOGLE_SECURETOKEN_X509_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/** The provider name of every identity this verifier authenticates (identities.provider; user id = UUIDv5(provider, sub)). */
export const IDENTITY_PLATFORM_PROVIDER = "identity-platform";

/** An ID token longer than this is not one Identity Platform issues. */
export const MAX_ID_TOKEN_LENGTH = 8_192;

/** A fetch of the key document: the global fetch, or a test's. */
export type KeyDocumentFetch = (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;

/** A JSON Web Key Set as the contract fake publishes it. */
export interface JsonWebKeySet {
  readonly keys: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export type IdentityKeySource =
  | { readonly kind: "GOOGLE_X509"; readonly fetch?: KeyDocumentFetch; readonly url?: string }
  | { readonly kind: "CONTRACT_FAKE"; readonly jwks: JsonWebKeySet };

export interface IdentityTokenVerifierOptions {
  /** The Google Cloud project id: the audience, and the issuer's last segment. */
  readonly projectId: string;
  readonly environment: Environment;
  readonly keySource: IdentityKeySource;
  /** The clock token instants and the key cache are judged by (the api's clock). */
  readonly clock?: Clock;
}

const systemClock: Clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const KEY_REFRESH_FLOOR_MS = 60_000;
const FAILED_FETCH_COOLDOWN_MS = 5_000;
const KEY_FETCH_TIMEOUT_MS = 3_000;

type KeyLookup = { readonly kind: "KEY"; readonly key: KeyObject } | { readonly kind: "UNKNOWN" } | { readonly kind: "UNAVAILABLE" };

interface KeyResolver {
  resolve(kid: string): Promise<KeyLookup>;
}

function rsaKey(key: KeyObject): boolean {
  return key.type === "public" && key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
}

/** The contract fake's JWKS: the keys it names, by kid (LOCAL only). */
function jwksResolver(jwks: JsonWebKeySet): KeyResolver {
  const keys = new Map<string, KeyObject>();
  for (const jwk of jwks.keys) {
    const kid = jwk["kid"];
    if (typeof kid !== "string" || kid === "") throw new TypeError("every key of the contract fake's JWKS names its kid");
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    if (!rsaKey(key)) throw new TypeError("the contract fake's JWKS holds only RSA keys of at least 2048 bits");
    keys.set(kid, key);
  }
  return {
    async resolve(kid) {
      const key = keys.get(kid);
      return key === undefined ? { kind: "UNKNOWN" } : { kind: "KEY", key };
    },
  };
}

/** Google's securetoken certificates, cached for the document's max-age, refreshed for an unknown kid at most once a minute. */
function googleX509Resolver(source: Extract<IdentityKeySource, { kind: "GOOGLE_X509" }>, clock: Clock): KeyResolver {
  const fetchDocument: KeyDocumentFetch = source.fetch ?? ((url, init) => fetch(url, init === undefined ? undefined : { signal: init.signal ?? null }));
  const url = source.url ?? GOOGLE_SECURETOKEN_X509_URL;
  let cache: { readonly keys: ReadonlyMap<string, KeyObject>; readonly expiresAtMs: number } | null = null;
  let lastFetchMs = Number.NEGATIVE_INFINITY;
  let lastFailureMs = Number.NEGATIVE_INFINITY;

  const refresh = async (): Promise<boolean> => {
    const started = clock.nowMs();
    lastFetchMs = started;
    try {
      const answer = await fetchDocument(url, { signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) });
      if (answer.status !== 200) throw new Error(`the key document answered ${answer.status}`);
      const maxAge = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(answer.headers.get("cache-control") ?? "");
      if (maxAge === null) throw new Error("the key document carries no Cache-Control max-age");
      const document: unknown = await answer.json();
      if (typeof document !== "object" || document === null || Array.isArray(document)) throw new Error("the key document is not an object");
      const keys = new Map<string, KeyObject>();
      for (const [kid, pem] of Object.entries(document)) {
        if (typeof pem !== "string") throw new Error("a key of the document is not a PEM certificate");
        const key = new X509Certificate(pem).publicKey;
        if (!rsaKey(key)) throw new Error("a key of the document is not an RSA key of at least 2048 bits");
        keys.set(kid, key);
      }
      if (keys.size === 0) throw new Error("the key document names no key");
      cache = { keys, expiresAtMs: started + Number(maxAge[1]) * 1000 };
      return true;
    } catch {
      // the cause is the key source's, never the caller's: the verification answers UNAVAILABLE (a retryable 503)
      lastFailureMs = started;
      return false;
    }
  };

  return {
    async resolve(kid) {
      const now = clock.nowMs();
      const live = cache !== null && now < cache.expiresAtMs ? cache : null;
      if (live !== null) {
        const key = live.keys.get(kid);
        if (key !== undefined) return { kind: "KEY", key };
        // a kid the live document does not name: a rotation is fetched, at most once a minute
        if (now - lastFetchMs < KEY_REFRESH_FLOOR_MS) return { kind: "UNKNOWN" };
      } else if (now - lastFailureMs < FAILED_FETCH_COOLDOWN_MS) {
        return { kind: "UNAVAILABLE" };
      }
      if (!(await refresh())) return { kind: "UNAVAILABLE" };
      const key = cache?.keys.get(kid);
      return key === undefined ? { kind: "UNKNOWN" } : { kind: "KEY", key };
    },
  };
}

/** A NumericDate this platform can represent as an instant (seconds since the epoch, before the year 10000). */
function isNumericDate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 253_402_300_799;
}

function rejected(defect: IdentityTokenDefect): IdentityTokenVerification {
  return { kind: "REJECTED", defect };
}

function defectOf(e: unknown): IdentityTokenDefect {
  if (e instanceof errors.JOSEAlgNotAllowed) return "ALGORITHM";
  if (e instanceof errors.JWSSignatureVerificationFailed) return "SIGNATURE";
  if (e instanceof errors.JWTExpired) return "EXPIRED";
  if (e instanceof errors.JWTClaimValidationFailed) {
    if (e.reason === "missing") return "CLAIM";
    if (e.claim === "iss") return "ISSUER";
    if (e.claim === "aud") return "AUDIENCE";
    if (e.claim === "nbf") return "NOT_YET_VALID";
    return "CLAIM";
  }
  return "MALFORMED";
}

/** The verifier of the api (D-AUTH-3). Throws at construction when the key source is not allowed in the environment. */
export function createIdentityTokenVerifier(options: IdentityTokenVerifierOptions): IdentityTokenVerifier {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId)) throw new RangeError("the identity project id is 6..30 lowercase letters, digits and hyphens");
  if (options.keySource.kind === "CONTRACT_FAKE" && options.environment !== "LOCAL") {
    throw new Error(`the CONTRACT_FAKE key source is accepted in the LOCAL environment only, never in ${options.environment} (B11 design D-AUTH-3)`);
  }
  const clock = options.clock ?? systemClock;
  const resolver = options.keySource.kind === "CONTRACT_FAKE" ? jwksResolver(options.keySource.jwks) : googleX509Resolver(options.keySource, clock);
  const issuer = `https://securetoken.google.com/${options.projectId}`;
  const skewSeconds = SESSION_POLICY.tokenSkewSeconds;

  return {
    async verify(idToken): Promise<IdentityTokenVerification> {
      if (typeof idToken !== "string" || idToken.length > MAX_ID_TOKEN_LENGTH || !JWT_SHAPE.test(idToken)) return rejected("MALFORMED");
      let header: ReturnType<typeof decodeProtectedHeader>;
      try {
        header = decodeProtectedHeader(idToken);
      } catch {
        return rejected("MALFORMED");
      }
      if (header.alg !== "RS256") return rejected("ALGORITHM");
      if (typeof header.kid !== "string" || header.kid === "") return rejected("UNKNOWN_KEY");
      const lookup = await resolver.resolve(header.kid);
      if (lookup.kind === "UNAVAILABLE") return { kind: "UNAVAILABLE" };
      if (lookup.kind === "UNKNOWN") return rejected("UNKNOWN_KEY");
      const nowMs = clock.nowMs();
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(idToken, lookup.key, {
          algorithms: ["RS256"],
          issuer,
          audience: options.projectId,
          requiredClaims: ["exp", "iat", "auth_time", "sub"],
          currentDate: new Date(nowMs),
          clockTolerance: 0,
        });
        payload = verified.payload as Record<string, unknown>;
      } catch (e) {
        return rejected(defectOf(e));
      }
      const nowSeconds = nowMs / 1000;
      const iat = payload["iat"];
      const authTime = payload["auth_time"];
      const exp = payload["exp"];
      if (!isNumericDate(iat)) return rejected("CLAIM");
      if (!isNumericDate(authTime)) return rejected("AUTH_TIME");
      if (!isNumericDate(exp)) return rejected("EXPIRED");
      if (iat > nowSeconds + skewSeconds) return rejected("NOT_YET_VALID");
      if (authTime > nowSeconds + skewSeconds) return rejected("AUTH_TIME");
      const sub = payload["sub"];
      if (typeof sub !== "string" || sub.length < 1 || sub.length > 128) return rejected("SUBJECT");
      if (payload["user_id"] !== undefined && payload["user_id"] !== sub) return rejected("SUBJECT");
      const emailVerified = payload["email_verified"];
      if (emailVerified !== undefined && typeof emailVerified !== "boolean") return rejected("CLAIM");
      const firebase = payload["firebase"];
      if (firebase !== undefined && (typeof firebase !== "object" || firebase === null || Array.isArray(firebase))) return rejected("CLAIM");
      const secondFactor = (firebase as Record<string, unknown> | undefined)?.["sign_in_second_factor"];
      if (secondFactor !== undefined && (typeof secondFactor !== "string" || secondFactor === "")) return rejected("CLAIM");
      const instant = (seconds: number) => toUtcInstant(Math.floor(seconds) * 1000);
      return {
        kind: "VERIFIED",
        token: {
          provider: IDENTITY_PLATFORM_PROVIDER,
          subject: sub,
          emailVerified: emailVerified === true,
          secondFactor: secondFactor === undefined ? null : (secondFactor as string),
          authTime: instant(authTime),
          issuedAt: instant(iat),
          expiresAt: instant(exp),
        },
      };
    },
  };
}

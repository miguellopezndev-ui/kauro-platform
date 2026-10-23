/**
 * Pluggable identity providers (O23A; A9 "Identity: Cognito where it maps to Identity Platform"; B11 design D-AUTH-3).
 *
 * The session boundary consumes one port, the IdentityTokenVerifier of @kauro/application: a provider is a verifier that turns
 * that provider's ID token into the same VerifiedIdentityToken facts. Which provider is live is NOT decided here (O23B, an
 * OWNER_GATE): this module names the providers, their activation state, and refuses a selection the state does not allow.
 *
 *   IDENTITY_PLATFORM  SERVED          the verifier the api binds today (apps/api identity-verifier.ts); unchanged.
 *   COGNITO            CANDIDATE_OFF   an offline verifier of the documented Cognito user-pool ID token shape, built and tested
 *                                      against the simulator only; selectable in LOCAL with its candidate flag on, never elsewhere.
 *   SIMULATOR          LOCAL_ONLY      the offline Cognito-shaped simulator of @kauro/identity/testing (evidence SIMULATED).
 *
 * Cognito ID token (AWS "Verifying a JSON web token", "Understanding the identity (ID) token"): header alg RS256 and kid from the
 * pool's JWKS (https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json); payload iss = that pool URL, aud = the
 * app client id, token_use = "id", sub, auth_time, iat, exp, email_verified. Cognito's ID token carries NO second-factor claim:
 * the claim that proves MFA is a deployment decision (a pre-token-generation trigger, O23B). Until then `secondFactorClaim` is
 * null and every Cognito token is single-factor, so no step-up can be proved with it (fail closed).
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import { decodeProtectedHeader, errors, jwtVerify } from "jose";
import type { IdentityTokenDefect, IdentityTokenVerification, IdentityTokenVerifier } from "@kauro/application";
import { SESSION_POLICY } from "@kauro/application";
import type { Clock, Environment } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";

export type IdentityProviderKind = "IDENTITY_PLATFORM" | "COGNITO" | "SIMULATOR";

/** SERVED: bound today. CANDIDATE_OFF: built offline, activation off until O23B. LOCAL_ONLY: a simulator. */
export type ProviderActivation = "SERVED" | "CANDIDATE_OFF" | "LOCAL_ONLY";

export const IDENTITY_PROVIDERS: Readonly<Record<IdentityProviderKind, { readonly provider: string; readonly activation: ProviderActivation; readonly unlock: string }>> = Object.freeze({
  IDENTITY_PLATFORM: { provider: "identity-platform", activation: "SERVED", unlock: "served (B11)" },
  COGNITO: { provider: "cognito", activation: "CANDIDATE_OFF", unlock: "O23B: live provider selection (OWNER_GATE), the MFA claim decision and the identity migration of existing subjects" },
  SIMULATOR: { provider: "cognito-simulator", activation: "LOCAL_ONLY", unlock: "never served: evidence class SIMULATED" },
});

export interface ProviderSelection {
  readonly kind: IdentityProviderKind;
  readonly environment: Environment;
  /** KAURO_IDENTITY_COGNITO_CANDIDATE: off unless set exactly to "on". */
  readonly cognitoCandidate: boolean;
}

/** Refuses a provider selection its activation state does not allow; the default is the served provider. */
export function assertProviderSelection(selection: ProviderSelection): void {
  const { kind, environment } = selection;
  if (kind === "IDENTITY_PLATFORM") return;
  if (kind === "SIMULATOR" && environment !== "LOCAL") throw new Error(`the identity SIMULATOR is LOCAL only, never ${environment} (O23A)`);
  if (kind === "COGNITO") {
    if (!selection.cognitoCandidate) throw new Error("the COGNITO identity provider is a candidate with its activation off (KAURO_IDENTITY_COGNITO_CANDIDATE is not on; unlock: O23B)");
    if (environment !== "LOCAL") throw new Error(`the COGNITO candidate is selectable in LOCAL only until O23B, never ${environment}`);
  }
}

/** The provider selection a configuration names (KAURO_IDENTITY_PROVIDER, KAURO_IDENTITY_COGNITO_CANDIDATE); refused when not allowed. */
export function providerSelectionOf(env: Readonly<Record<string, string | undefined>>, environment: Environment): ProviderSelection {
  const raw = env["KAURO_IDENTITY_PROVIDER"] ?? "IDENTITY_PLATFORM";
  if (raw !== "IDENTITY_PLATFORM" && raw !== "COGNITO" && raw !== "SIMULATOR") throw new Error("KAURO_IDENTITY_PROVIDER is IDENTITY_PLATFORM, COGNITO or SIMULATOR");
  const flag = env["KAURO_IDENTITY_COGNITO_CANDIDATE"];
  if (flag !== undefined && flag !== "on" && flag !== "off") throw new Error("KAURO_IDENTITY_COGNITO_CANDIDATE is on or off");
  const selection: ProviderSelection = { kind: raw, environment, cognitoCandidate: flag === "on" };
  assertProviderSelection(selection);
  return selection;
}

// --- Cognito user-pool ID token verifier (offline candidate) -------------------------------------------------------------

export interface JsonWebKeySet {
  readonly keys: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface CognitoVerifierOptions {
  /** e.g. us-east-1 */
  readonly region: string;
  /** e.g. us-east-1_AbCdEfGhI */
  readonly userPoolId: string;
  /** The app client id: the ID token's aud. */
  readonly clientId: string;
  /** The pool's JWKS, injected (offline: the simulator's; a live fetch is O23B's). */
  readonly jwks: JsonWebKeySet;
  /** The claim that proves a second factor (O23B decides it); null: none, every token is single-factor. */
  readonly secondFactorClaim: string | null;
  /** The provider name the session records (IDENTITY_PROVIDERS.COGNITO.provider, or the simulator's). */
  readonly provider: string;
  readonly clock: Clock;
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const POOL = /^[a-z]{2}(?:-[a-z]+)+-\d_[A-Za-z0-9]{1,55}$/;
const CLIENT = /^[a-z0-9]{1,128}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
export const MAX_ID_TOKEN_LENGTH = 8_192;

function rsaKey(key: KeyObject): boolean {
  return key.type === "public" && key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
}

function isNumericDate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 253_402_300_799;
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

/** The issuer URL of a user pool. */
export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

/** The offline Cognito verifier: the same port, the same defects, the same facts as the served verifier. */
export function createCognitoTokenVerifier(options: CognitoVerifierOptions): IdentityTokenVerifier {
  if (!REGION.test(options.region)) throw new RangeError("the Cognito region is an AWS region name");
  if (!POOL.test(options.userPoolId) || !options.userPoolId.startsWith(`${options.region}_`)) throw new RangeError("the user pool id is <region>_<id>");
  if (!CLIENT.test(options.clientId)) throw new RangeError("the app client id is 1..128 lowercase letters and digits");
  const keys = new Map<string, KeyObject>();
  for (const jwk of options.jwks.keys) {
    const kid = jwk["kid"];
    if (typeof kid !== "string" || kid === "") throw new TypeError("every key of the pool's JWKS names its kid");
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    if (!rsaKey(key)) throw new TypeError("the pool's JWKS holds only RSA keys of at least 2048 bits");
    keys.set(kid, key);
  }
  const issuer = cognitoIssuer(options.region, options.userPoolId);
  const skew = SESSION_POLICY.tokenSkewSeconds;
  const rejected = (defect: IdentityTokenDefect): IdentityTokenVerification => ({ kind: "REJECTED", defect });

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
      const key = keys.get(header.kid);
      if (key === undefined) return rejected("UNKNOWN_KEY");
      const nowMs = options.clock.nowMs();
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(idToken, key, {
          algorithms: ["RS256"],
          issuer,
          audience: options.clientId,
          requiredClaims: ["exp", "iat", "auth_time", "sub", "token_use"],
          currentDate: new Date(nowMs),
          clockTolerance: 0,
        });
        payload = verified.payload as Record<string, unknown>;
      } catch (e) {
        return rejected(defectOf(e));
      }
      // an access token (token_use "access", no aud) is never a sign-in proof
      if (payload["token_use"] !== "id") return rejected("CLAIM");
      const nowSeconds = nowMs / 1000;
      const iat = payload["iat"];
      const authTime = payload["auth_time"];
      const exp = payload["exp"];
      if (!isNumericDate(iat)) return rejected("CLAIM");
      if (!isNumericDate(authTime)) return rejected("AUTH_TIME");
      if (!isNumericDate(exp)) return rejected("EXPIRED");
      if (iat > nowSeconds + skew) return rejected("NOT_YET_VALID");
      if (authTime > nowSeconds + skew || authTime > iat + skew) return rejected("AUTH_TIME");
      const sub = payload["sub"];
      if (typeof sub !== "string" || sub.length < 1 || sub.length > 128) return rejected("SUBJECT");
      const emailVerified = payload["email_verified"];
      if (emailVerified !== undefined && typeof emailVerified !== "boolean") return rejected("CLAIM");
      let secondFactor: string | null = null;
      if (options.secondFactorClaim !== null) {
        const value = payload[options.secondFactorClaim];
        if (value !== undefined && (typeof value !== "string" || value === "" || value.length > 32)) return rejected("CLAIM");
        secondFactor = value === undefined ? null : value;
      }
      const instant = (seconds: number) => toUtcInstant(Math.floor(seconds) * 1000);
      return {
        kind: "VERIFIED",
        token: {
          provider: options.provider,
          subject: sub,
          emailVerified: emailVerified === true,
          secondFactor,
          authTime: instant(authTime),
          issuedAt: instant(iat),
          expiresAt: instant(exp),
        },
      };
    },
  };
}

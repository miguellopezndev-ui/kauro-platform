/**
 * The browser session protocol (B11 design D-AUTH-1, D-AUTH-5; 08 "Authentication and assurance": session cookies are Secure,
 * HttpOnly and have a deliberate SameSite policy; CSRF protection validates an exact origin and a per-session token; CORS
 * permits only observed application origins — here none: the browser calls the api on its own origin, D-TOPO-1).
 *
 * Transport-neutral: the functions read lowercased single-valued header maps and return values or throw the failure the
 * authentication step answers. Nothing here touches a database or a clock.
 *
 *  - The session secret is 32 random bytes, carried base64url-encoded (43 characters) in exactly one `__Host-kauro_session`
 *    cookie (`Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age` = the absolute lifetime; Lax because the payment provider's
 *    return and e-mail links are cross-site top-level navigations). The api stores only SHA-256 of the 32 bytes.
 *  - The CSRF token of a session is base64url(HMAC-SHA256(secret bytes, "kauro-csrf-v1")): the SessionView hands it to the page,
 *    which sends it as X-Kauro-CSRF on every unsafe request; the server recomputes it from the cookie and compares in constant
 *    time, so no CSRF state is stored.
 *  - An unsafe request authenticated by the cookie needs its exact Origin among the configured application origins (an absent
 *    Origin is refused), a Sec-Fetch-Site of `same-origin` when the browser sends one, and the token. These are decided at
 *    authentication, before the command journal is reserved, so a refused request consumes no idempotency key.
 *  - A request that carries a session cookie and an Authorization header, or two session cookies, is AMBIGUOUS_CREDENTIALS: the
 *    server never chooses between two claimed identities (as it never chooses between two values of a repeated header, R41).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import type { RandomBytes } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";

export const SESSION_COOKIE = "__Host-kauro_session";
export const CSRF_HEADER = "x-kauro-csrf";
/** The HMAC context of the CSRF token: a new token scheme is a new context string. */
export const CSRF_CONTEXT = "kauro-csrf-v1";

/**
 * Session lifetimes (Q-B11-2: the policy registry has none; ASVS 4.0.3 V3.3.2 L2 — 12 h absolute, 30 min idle). Last-seen is
 * written at most once a minute; a step-up re-authentication counts when it is at most five minutes old; token instants are
 * trusted with thirty seconds of clock skew (D-AUTH-3).
 */
export const SESSION_POLICY = Object.freeze({
  idleSeconds: 1_800,
  absoluteSeconds: 43_200,
  touchSeconds: 60,
  stepUpReauthenticationSeconds: 300,
  tokenSkewSeconds: 30,
});

/** The Clear-Site-Data of a logout (D-PRIV-1: cached private content is cleared on logout where the browser allows it). */
export const CLEAR_SITE_DATA = '"cache", "cookies", "storage"';

const SECRET_BYTES = 32;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A fresh session secret: 32 random bytes, base64url. */
export function mintSessionSecret(random: RandomBytes): string {
  const bytes = random(SECRET_BYTES);
  if (bytes.byteLength !== SECRET_BYTES) throw new RangeError("the entropy source returned the wrong number of bytes");
  return Buffer.from(bytes).toString("base64url");
}

/** The 32 bytes a well-formed secret encodes, or null for anything else (a value this server could not have issued). */
export function sessionSecretBytes(secret: string): Buffer | null {
  if (!SECRET_SHAPE.test(secret)) return null;
  const bytes = Buffer.from(secret, "base64url");
  return bytes.byteLength === SECRET_BYTES && bytes.toString("base64url") === secret ? bytes : null;
}

/** SHA-256 of the secret's bytes: the only form in which the api stores a session. */
export function sessionSecretDigest(secret: string): Sha256Hex {
  const bytes = sessionSecretBytes(secret);
  if (bytes === null) throw new RangeError("not a session secret");
  return createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
}

/** The session's CSRF token. */
export function csrfTokenOf(secret: string): string {
  const bytes = sessionSecretBytes(secret);
  if (bytes === null) throw new RangeError("not a session secret");
  return createHmac("sha256", bytes).update(CSRF_CONTEXT, "utf8").digest("base64url");
}

/** The Set-Cookie value that hands a session to the browser. */
export function sessionCookie(secret: string): string {
  return `${SESSION_COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_POLICY.absoluteSeconds}`;
}

/** The Set-Cookie value that removes it (same name, path and attributes; Max-Age=0). */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Every value of the session cookie in a Cookie header (RFC 6265 §5.4: `name=value` pairs separated by "; "). */
export function sessionCookieValues(cookieHeader: string | undefined): ReadonlyArray<string> {
  if (cookieHeader === undefined) return [];
  const out: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    if (pair.slice(0, at).trim() === SESSION_COOKIE) out.push(pair.slice(at + 1).trim());
  }
  return out;
}

/** Whether a method changes state (D-AUTH-5: CSRF is checked on every unsafe method authenticated by the cookie). */
export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/**
 * A browser origin as the configuration names it: `https://host[:port]` exactly as the URL standard serializes it (lowercase,
 * no path, no trailing slash, no default port); `http://` only for localhost and loopback, and only where `allowHttp` says so.
 */
export function isApplicationOrigin(value: string, allowHttp: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  if (url.protocol === "https:") return true;
  return allowHttp && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/**
 * The request's Origin and Sec-Fetch-Site against the application origins (D-AUTH-5; the login form's POST /sessions as well,
 * against login CSRF): refused unless Origin is exactly one of them, and, when the browser sends Sec-Fetch-Site, it is
 * `same-origin`.
 */
export function assertApplicationOrigin(headers: Readonly<Record<string, string | undefined>>, appOrigins: ReadonlyArray<string>): void {
  const origin = headers["origin"];
  if (origin === undefined || !appOrigins.includes(origin)) {
    throw new DomainFailure("NOT_AUTHORIZED", "the request's origin is not an application origin", { reason: "ORIGIN_REJECTED" });
  }
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    throw new DomainFailure("NOT_AUTHORIZED", "the browser reports a request from another site", { reason: "ORIGIN_REJECTED" });
  }
}

/** The credential a request presents, decided before any identity is looked up. */
export type PresentedCredential =
  | { readonly kind: "NONE" }
  | { readonly kind: "BEARER" }
  /** `secret` is null when the cookie's value is not a secret this server could have issued (it authenticates nobody). */
  | { readonly kind: "SESSION"; readonly secret: string | null };

/**
 * Which credential a request presents, and the CSRF rule of an unsafe cookie-authenticated request (D-AUTH-5). Throws the
 * refusal the authentication step answers: AMBIGUOUS_CREDENTIALS (a cookie beside an Authorization header, or two session
 * cookies), ORIGIN_REJECTED, CSRF_TOKEN_INVALID. `checkCsrf` is false for the sign-in request itself, which presents an
 * identity token rather than a session (its Origin is checked by the route).
 */
export function presentedCredential(
  request: { readonly method: string; readonly headers: Readonly<Record<string, string | undefined>> },
  appOrigins: ReadonlyArray<string>,
  checkCsrf = true,
): PresentedCredential {
  const cookies = sessionCookieValues(request.headers["cookie"]);
  const bearer = request.headers["authorization"] !== undefined;
  if (cookies.length > 1 || (cookies.length === 1 && bearer)) {
    throw new DomainFailure("INVALID_REQUEST", "the request presents more than one credential", { reason: "AMBIGUOUS_CREDENTIALS" });
  }
  if (cookies.length === 0) return bearer ? { kind: "BEARER" } : { kind: "NONE" };
  const secret = sessionSecretBytes(cookies[0] as string) === null ? null : (cookies[0] as string);
  if (checkCsrf && isUnsafeMethod(request.method)) {
    assertApplicationOrigin(request.headers, appOrigins);
    if (secret !== null) {
      const presented = Buffer.from(request.headers[CSRF_HEADER] ?? "", "utf8");
      const expected = Buffer.from(csrfTokenOf(secret), "utf8");
      if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
        throw new DomainFailure("NOT_AUTHORIZED", "the request does not carry the session's CSRF token", { reason: "CSRF_TOKEN_INVALID" });
      }
    }
  }
  return { kind: "SESSION", secret };
}

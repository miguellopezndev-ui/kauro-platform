/**
 * The browser security policy of every response of the web application (B11 design D-SEC-1; 08 "Browser, API and cache
 * isolation"; 08 "Quarantine and malware boundaries": uploaded content is never served inline under the application's origin;
 * reference UI_STATE_AND_COPY_CONTRACT: no external font request).
 *
 * The Content-Security-Policy is per request: `proxy.ts` mints a nonce, the framework attaches it to its own scripts, and no
 * inline script, inline style attribute, eval, plugin, frame or foreign origin is admitted. The only foreign origins a page may
 * ever connect to are passed explicitly (the identity provider's endpoints on the sign-in pages, D-AUTH-2), and each must be an
 * https origin without a path or wildcard.
 */

export const NONCE_REQUEST_HEADER = "x-nonce";

export interface ContentSecurityPolicyOptions {
  /** The per-request nonce (newNonce). */
  readonly nonce: string;
  /** Extra https origins the page may connect to (fetch/XHR); none by default. */
  readonly connectOrigins?: ReadonlyArray<string>;
  /** Adds upgrade-insecure-requests; off only for a plain-http local development server. */
  readonly upgradeInsecureRequests?: boolean;
}

const NONCE = /^[A-Za-z0-9+/]{22}==$/;
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A fresh 128-bit nonce, base64 (the CSP nonce-source grammar). */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function contentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  if (!NONCE.test(options.nonce)) throw new RangeError("the nonce must be 128 bits of base64 (newNonce)");
  const connect = options.connectOrigins ?? [];
  for (const origin of connect) {
    if (!HTTPS_ORIGIN.test(origin)) throw new RangeError(`a connect origin must be an https origin without path or wildcard: ${origin}`);
  }
  const nonce = `'nonce-${options.nonce}'`;
  const directives: Array<readonly [string, ReadonlyArray<string>]> = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'", nonce, "'strict-dynamic'"]],
    ["style-src", ["'self'", nonce]],
    ["style-src-attr", ["'none'"]],
    ["img-src", ["'self'"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...connect]],
    ["manifest-src", ["'self'"]],
    ["media-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["worker-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["base-uri", ["'none'"]],
  ];
  const text = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (options.upgradeInsecureRequests !== false) text.push("upgrade-insecure-requests");
  return text.join("; ");
}

/** The headers every response carries, whatever route produced it (static assets included). */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ readonly key: string; readonly value: string }> = Object.freeze([
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Permissions-Policy",
    value: "accelerometer=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  },
]);

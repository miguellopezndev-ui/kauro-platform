/**
 * Per-request browser policy (B11 design D-SEC-1). This proxy only mints the CSP nonce and sets the policy headers; it is never
 * an authorization layer (08 "Identity is not permission": the api decides every access; Next.js proxy bypasses such as
 * GHSA-26hh-7cqf-hhc6 are therefore not access bypasses here). It runs on every request except the immutable build assets, so
 * the root layout can refuse to render a document without the nonce it was given.
 */
import { NextResponse, type NextRequest } from "next/server";
import { NONCE_REQUEST_HEADER, contentSecurityPolicy, newNonce } from "./server/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = contentSecurityPolicy({ nonce, upgradeInsecureRequests: request.nextUrl.protocol === "https:" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static/|favicon\\.ico$).*)"],
};

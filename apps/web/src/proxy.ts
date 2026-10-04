/**
 * Per-request browser policy and host routing (B11 design D-SEC-1, D-TOPO-2). This proxy mints the CSP nonce, sets the policy headers, and
 * answers 404 for the other group's paths by host. It is never an authorization layer (08 "Identity is not permission": the api decides
 * every access; Next.js proxy bypasses such as GHSA-26hh-7cqf-hhc6 are therefore not access bypasses here). It runs on every request
 * except the immutable build assets, so the root layout can refuse to render a document without the nonce it was given.
 */
import { NextResponse, type NextRequest } from "next/server";
import { hostConfig } from "./server/config/hosts.ts";
import { decideRoute } from "./server/host-routing.ts";
import { NONCE_REQUEST_HEADER, contentSecurityPolicy, newNonce } from "./server/security-headers.ts";

/** A path no page owns: rewriting to it makes the application's own not-found document answer, the one every missing path gets. */
const NOT_FOUND_PATH = "/_kauro/not-found";

export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = contentSecurityPolicy({ nonce, upgradeInsecureRequests: request.nextUrl.protocol === "https:" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const decision = decideRoute(hostConfig(), request.headers.get("host"), request.nextUrl.pathname);
  const response =
    decision === "PASS"
      ? NextResponse.next({ request: { headers: requestHeaders } })
      : decision === "NOT_FOUND"
        ? NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url), { request: { headers: requestHeaders } })
        : new NextResponse("Service unavailable\n", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static/|favicon\.ico$).*)"],
};

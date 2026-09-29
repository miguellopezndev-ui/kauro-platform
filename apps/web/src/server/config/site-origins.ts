import "server-only";
import { publicationUrl, signInUrl } from "../public-origins.ts";

// The only reader of the deployment's origins for the public pages (D-SEC-2). Read on each call: it is a property lookup, and a deployment
// does not change its origins while it runs, so nothing is cached here and nothing is stale.

/** The address of the capability publication, or null when the deployment names no usable public origin. */
export function publicationAddress(): string | null {
  return publicationUrl({ KAURO_ENV: process.env["KAURO_ENV"], KAURO_PUBLIC_ORIGIN: process.env["KAURO_PUBLIC_ORIGIN"] });
}

/** Where the visitor signs in: the application origin's /login, or the local path (see signInUrl). */
export function signInAddress(): string {
  return signInUrl({ KAURO_ENV: process.env["KAURO_ENV"], KAURO_PUBLIC_ORIGIN: process.env["KAURO_PUBLIC_ORIGIN"], KAURO_APP_ORIGIN: process.env["KAURO_APP_ORIGIN"] });
}

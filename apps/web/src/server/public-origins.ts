// The two addresses the public pages take from the deployment (design D-TOPO-1, D-TOPO-2, D-SEC-2): where the capability publication is
// read, and where a visitor signs in. This module is pure: it is handed the environment values and reads no environment, so node:test
// exercises it; the one file that reads them is config/site-origins.ts, which starts with `import "server-only"`.
//
// The public site reads the publication from its own origin (the deployment routes /api/v1 to the api on both hosts). A local stack that
// names no origin has nothing to read, and the pages then say the publication cannot be read: they never guess an address.
//
// Sign-in is an application route, and in a split deployment the public host does not serve application routes (W3's host routing answers
// 404), so the link from the public site must name the application origin. When the deployment does not name a distinct one, the link is
// the local path, which is right for a single-origin stack.
import { PUBLICATION_PATH } from "../public/capabilities.ts";

export interface PublicOriginEnvironment {
  readonly KAURO_ENV: string | undefined;
  readonly KAURO_PUBLIC_ORIGIN: string | undefined;
}

/** `https://host[:port]` exactly as the URL parser prints an origin; plain http only for the local stack. */
function originOf(value: string, local: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value || url.host === "") return null;
  if (url.protocol === "https:") return url.origin;
  return local && url.protocol === "http:" ? url.origin : null;
}

/** The publication URL, or null when no usable public origin is named. */
export function publicationUrl(environment: PublicOriginEnvironment): string | null {
  const value = environment.KAURO_PUBLIC_ORIGIN;
  if (value === undefined || value === "") return null;
  const origin = originOf(value, environment.KAURO_ENV === "LOCAL");
  return origin === null ? null : `${origin}${PUBLICATION_PATH}`;
}

export interface SiteEnvironment extends PublicOriginEnvironment {
  readonly KAURO_APP_ORIGIN: string | undefined;
}

/**
 * Where a visitor signs in: the application origin's /login when the deployment names a valid application origin that differs from the
 * public one, and otherwise the local path. An origin that is not exactly `https://host[:port]` (a path, credentials, a trailing slash, a
 * script scheme, plain http outside the local stack) is refused, so an environment value can never put a foreign or scripted address into
 * a link on a page.
 */
export function signInUrl(environment: SiteEnvironment): string {
  const local = environment.KAURO_ENV === "LOCAL";
  const named = (value: string | undefined): string | null => (value === undefined || value === "" ? null : originOf(value, local));
  const app = named(environment.KAURO_APP_ORIGIN);
  const site = named(environment.KAURO_PUBLIC_ORIGIN);
  return app !== null && site !== null && app !== site ? `${app}/login` : "/login";
}

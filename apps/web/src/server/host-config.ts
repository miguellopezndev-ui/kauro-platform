// The host arrangement of a deployment, read from its environment values (design D-TOPO-2, D-SEC-2). This module is pure: it is handed the
// values and reads no environment, so `node:test` can exercise it; the one file that reads the environment is `config/hosts.ts`, which starts
// with `import "server-only"`.
//
// Hosts are deployment facts. A deployment names both origins (`KAURO_PUBLIC_ORIGIN`, `KAURO_APP_ORIGIN`), each an https origin with no
// path, and the two differ. Only the local stack (`KAURO_ENV=LOCAL`) may name none, and then one origin serves both groups; a deployment
// that names none, or one, or a malformed one, does not serve either group (503) instead of guessing.
/** How the deployment's hosts are arranged. LOCAL serves both groups on whatever host it is reached (the local stack and the browser suite). */
export type HostPolicy =
  | { readonly kind: "LOCAL" }
  | { readonly kind: "SPLIT"; readonly publicHost: string; readonly appHost: string };

export interface HostEnvironment {
  readonly KAURO_ENV: string | undefined;
  readonly KAURO_PUBLIC_ORIGIN: string | undefined;
  readonly KAURO_APP_ORIGIN: string | undefined;
}

export type HostConfigProblem = "ORIGINS_MISSING" | "ONE_ORIGIN_ONLY" | "ORIGIN_INVALID" | "ORIGINS_NOT_DISTINCT";

export type HostConfig =
  | { readonly ok: true; readonly policy: HostPolicy }
  | { readonly ok: false; readonly problem: HostConfigProblem };

const blank = (value: string | undefined): boolean => value === undefined || value === "";

/** `https://host[:port]` exactly as the URL parser would print it; plain http only for the local stack. */
function hostOf(value: string, local: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value || url.host === "") return null;
  if (url.protocol === "https:") return url.host;
  return local && url.protocol === "http:" ? url.host : null;
}

export function parseHostPolicy(environment: HostEnvironment): HostConfig {
  const local = environment.KAURO_ENV === "LOCAL";
  const publicOrigin = environment.KAURO_PUBLIC_ORIGIN;
  const appOrigin = environment.KAURO_APP_ORIGIN;
  if (blank(publicOrigin) && blank(appOrigin)) return local ? { ok: true, policy: { kind: "LOCAL" } } : { ok: false, problem: "ORIGINS_MISSING" };
  if (blank(publicOrigin) || blank(appOrigin) || publicOrigin === undefined || appOrigin === undefined) return { ok: false, problem: "ONE_ORIGIN_ONLY" };
  const publicHost = hostOf(publicOrigin, local);
  const appHost = hostOf(appOrigin, local);
  if (publicHost === null || appHost === null) return { ok: false, problem: "ORIGIN_INVALID" };
  if (publicHost === appHost) return { ok: false, problem: "ORIGINS_NOT_DISTINCT" };
  return { ok: true, policy: { kind: "SPLIT", publicHost, appHost } };
}

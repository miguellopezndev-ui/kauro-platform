// Which host serves which group of screens (design D-TOPO-2). One deployment answers on two hosts: the public origin serves the PUBLIC group
// (UI01-UI08, UI45-UI49) and the app origin serves the APP group (UI09-UI32, UI50-UI52). The proxy asks this module about every path and
// answers 404 for the other group's paths by host. It is presentation, never authorization (08 "Identity is not permission"): the api
// decides every access, and no private data is rendered by this server anyway.
//
// The classification is by the first path segment, and a path under a screen's first segment that no screen owns is a 404 as well. That
// closes the gap between this application's strict route map (`matchRoute`) and the framework's looser dynamic segments: a path such as
// `/agencies/a%20b/projects` or `/pricing/` is never handed to a page, on any host.
import { matchRoute, type Origin, SCREENS } from "../screens.ts";
import type { HostConfig, HostPolicy } from "./host-config.ts";

/** PASS: the framework routes it. NOT_FOUND: the not-found page answers, as for any missing path. UNAVAILABLE: the deployment's hosts are misconfigured. */
export type RouteDecision = "PASS" | "NOT_FOUND" | "UNAVAILABLE";

/** The first segment of every screen route ("" for the home page) and the group that owns it. */
const ROOTS: ReadonlyMap<string, Origin> = new Map(SCREENS.map((screen) => [screen.route === "/" ? "" : (screen.route.slice(1).split("/")[0] ?? ""), screen.origin] as const));

/** The group a first path segment belongs to, or null; the segment is percent-decoded once, as the framework does before it routes. */
export function groupOfRoot(segment: string): Origin | null | "MALFORMED" {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return "MALFORMED";
  }
  return ROOTS.get(decoded) ?? null;
}

/** The first segments that belong to a group, for the tests that check the two groups never share one. */
export function rootsOf(group: Origin): readonly string[] {
  return [...ROOTS].filter(([, origin]) => origin === group).map(([root]) => root);
}

/** The group a request host serves under a policy, or null for a host that serves neither. Hosts are compared exactly, lower-cased, with port. */
export function groupOfHost(policy: HostPolicy, host: string | null): Origin | null {
  if (policy.kind === "LOCAL" || host === null) return null;
  const value = host.toLowerCase();
  if (value === policy.publicHost) return "PUBLIC";
  if (value === policy.appHost) return "APP";
  return null;
}

/** Whether the framework may route this path on this host. Anything that is not under a screen's first segment (probes, assets, unknown paths) passes. */
export function decideRoute(config: HostConfig, host: string | null, pathname: string): RouteDecision {
  if (!pathname.startsWith("/")) return "NOT_FOUND";
  const group = groupOfRoot(pathname.slice(1).split("/")[0] ?? "");
  if (group === "MALFORMED") return "NOT_FOUND";
  if (group === null) return "PASS";
  if (matchRoute(pathname) === null) return "NOT_FOUND";
  if (!config.ok) return "UNAVAILABLE";
  if (config.policy.kind === "LOCAL") return "PASS";
  return groupOfHost(config.policy, host) === group ? "PASS" : "NOT_FOUND";
}

// The route map of the web application (design D-ROUTE-1, D-TOPO-2, D-SCR-1): every screen of the registry's screens.json is mapped to
// exactly one route here, and nothing else in the application names a route. The OPS screens (UI33-UI44, UI53-UI55) belong to the private
// origin: they live under `/ops` followed by their registry route (UI33, the private home, is `/ops`), and the proxy serves them only on the
// ops host (KAURO_OPS_ORIGIN; server/host-routing.ts).
//
// The rule that produces the routes (tested against the registry, not restated by it): a tenant screen lives under `/agencies/{agencyId}`
// followed by its registry route, so the agency travels in the URL (per tab, survives refresh, deep links) and as `X-Kauro-Agency`; the four
// agency-less APP screens (Agency setup, Agency switcher, Sign in, Accept invitation) keep their registry routes; the payment page names its
// order (`/payments/{orderId}`) because the provider's return URL names the agency and the order. Registry routes are internal names (A3 1.4).
import type { MessageId } from "./copy/en.ts";
import { IMPLEMENTED_BY_AREA } from "./screens/implemented/index.ts";

export type Origin = "PUBLIC" | "APP" | "OPS";

export interface Screen {
  readonly id: string;
  readonly origin: Origin;
  /** The route pattern; `{name}` is one path segment. */
  readonly route: string;
  /** Lives under /agencies/{agencyId}. */
  readonly tenant: boolean;
  /** Drawn without a session: the application shell puts nothing private around it and does not hold it back until the session is read. */
  readonly anonymous: boolean;
}

const pub = (id: string, route: string): Screen => ({ id, origin: "PUBLIC", route, tenant: false, anonymous: true });
const own = (id: string, route: string, anonymous = false): Screen => ({ id, origin: "APP", route, tenant: false, anonymous });
const tenant = (id: string, route: string): Screen => ({ id, origin: "APP", route: `/agencies/{agencyId}${route}`, tenant: true, anonymous: false });
const ops = (id: string, route: string): Screen => ({ id, origin: "OPS", route: route === "/" ? "/ops" : `/ops${route}`, tenant: false, anonymous: false });

export const SCREENS: readonly Screen[] = [
  pub("UI01", "/"),
  pub("UI02", "/how-it-works"),
  pub("UI03", "/supported-services"),
  pub("UI04", "/pricing"),
  pub("UI05", "/sample-delivery"),
  pub("UI06", "/security"),
  pub("UI07", "/contact"),
  pub("UI08", "/status"),
  own("UI09", "/onboarding"),
  own("UI10", "/agencies"),
  tenant("UI11", "/projects"),
  tenant("UI12", "/clients"),
  tenant("UI13", "/projects/{id}"),
  tenant("UI14", "/projects/{id}/sources"),
  tenant("UI15", "/projects/{id}/sources/selection"),
  tenant("UI16", "/projects/{id}/sources/seal"),
  tenant("UI17", "/projects/{id}/target"),
  tenant("UI18", "/projects/{id}/audit"),
  tenant("UI19", "/projects/{id}/plan/mapping"),
  tenant("UI20", "/projects/{id}/plan/duplicates"),
  tenant("UI21", "/projects/{id}/plan/relationships"),
  tenant("UI22", "/projects/{id}/plan/approval"),
  tenant("UI23", "/projects/{id}/purchase"),
  tenant("UI24", "/payments/{orderId}"),
  tenant("UI25", "/projects/{id}/processing"),
  tenant("UI26", "/projects/{id}/delivery"),
  tenant("UI27", "/projects/{id}/import"),
  tenant("UI28", "/projects/{id}/import/receipt"),
  tenant("UI29", "/projects/{id}/retention"),
  tenant("UI30", "/billing"),
  tenant("UI31", "/team"),
  tenant("UI32", "/settings"),
  pub("UI45", "/legal/terms"),
  pub("UI46", "/legal/privacy"),
  pub("UI47", "/legal/data-processing"),
  pub("UI48", "/help"),
  pub("UI49", "/unsubscribe/{token}"),
  own("UI50", "/login", true),
  own("UI51", "/invitations/{id}", true),
  tenant("UI52", "/support"),
  ops("UI33", "/"),
  ops("UI34", "/sales/prospects"),
  ops("UI35", "/sales/agencies/{id}"),
  ops("UI36", "/sales/statements"),
  ops("UI37", "/sales/sellers/{id}"),
  ops("UI38", "/owner/actions"),
  ops("UI39", "/finance"),
  ops("UI40", "/operations/jobs"),
  ops("UI41", "/operations/deletion"),
  ops("UI42", "/operations/incidents"),
  ops("UI43", "/releases"),
  ops("UI44", "/reviews"),
  ops("UI53", "/sales/resources"),
  ops("UI54", "/sales/outreach"),
  ops("UI55", "/support"),
];

/**
 * The screens whose page exists in this build. A navigation entry appears only for one of these (11 "Every navigation link resolves to
 * real content or an explicitly unavailable feature"); the mandate that lands a screen adds its id to its area module under screens/implemented/, and a test refuses an id
 * without its page file and a page file without its id. The public screens are W5a's: UI01-UI08, UI48 and UI49 are pages, and the
 * legal documents UI45-UI47 are route handlers that answer the whole document (D-LEGAL-1).
 */
export const IMPLEMENTED_SCREENS: ReadonlySet<string> = new Set<string>(Object.values(IMPLEMENTED_BY_AREA).flat());

export interface NavigationEntry {
  readonly screen: string;
  readonly label: MessageId;
}

/** The agency-level entries of the shell, in order (reference "Agency context stays visible through Projects, Clients, Team, Billing, Settings"). */
export const AGENCY_NAVIGATION: readonly NavigationEntry[] = [
  { screen: "UI11", label: "nav.projects.label" },
  { screen: "UI12", label: "nav.clients.label" },
  { screen: "UI31", label: "nav.team.label" },
  { screen: "UI30", label: "nav.billing.label" },
  { screen: "UI32", label: "nav.settings.label" },
  { screen: "UI52", label: "nav.support.label" },
];

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const PARAMETER = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;

/** The parameter names of a route pattern, in order. */
export function parametersOf(route: string): readonly string[] {
  return route
    .split("/")
    .map((segment) => PARAMETER.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

export function screenById(id: string): Screen {
  const screen = SCREENS.find((candidate) => candidate.id === id);
  if (screen === undefined) throw new RangeError(`no screen ${id}`);
  return screen;
}

/** The concrete path of a screen: exactly its parameters, each one URL-safe segment. */
export function pathOf(id: string, values: Readonly<Record<string, string>> = {}): string {
  const screen = screenById(id);
  const wanted = parametersOf(screen.route);
  const given = Object.keys(values);
  if (wanted.length !== given.length || wanted.some((name) => !Object.hasOwn(values, name))) throw new RangeError(`${id} takes exactly [${wanted.join(", ")}]`);
  return screen.route
    .split("/")
    .map((segment) => {
      const name = PARAMETER.exec(segment)?.[1];
      if (name === undefined) return segment;
      const value = values[name] ?? "";
      if (!SEGMENT.test(value)) throw new RangeError(`${id}: ${name} is not a URL-safe path segment`);
      return value;
    })
    .join("/");
}

export interface RouteMatch {
  readonly screen: Screen;
  readonly params: Readonly<Record<string, string>>;
}

/** The screen a concrete pathname is, or null. Strict: no trailing slash, no empty, dot or encoded segment, every parameter URL-safe. */
export function matchRoute(pathname: string): RouteMatch | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  const segments = pathname === "/" ? [""] : pathname.slice(1).split("/");
  for (const screen of SCREENS) {
    const pattern = screen.route === "/" ? [""] : screen.route.slice(1).split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < pattern.length && matched; index += 1) {
      const expected = pattern[index] ?? "";
      const actual = segments[index] ?? "";
      const name = PARAMETER.exec(expected)?.[1];
      if (name === undefined) matched = expected === actual;
      else if (SEGMENT.test(actual)) params[name] = actual;
      else matched = false;
    }
    if (matched) return { screen, params };
  }
  return null;
}

/** An agency id as the api issues it: a UUID (any version 1 to 8, RFC 4122 variant), lower case. */
export const AGENCY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The agency a pathname is in, or null for a path outside an agency (or one whose agency segment is not an agency id). */
export function agencyOfPathname(pathname: string): string | null {
  const agency = matchRoute(pathname)?.params["agencyId"];
  return agency !== undefined && AGENCY_ID.test(agency) ? agency : null;
}

/** Which origin's group a pathname belongs to, or null for a path no screen owns (system routes, unknown paths). */
export function originOfPath(pathname: string): Origin | null {
  return matchRoute(pathname)?.screen.origin ?? null;
}

/** The navigation entries of an agency, for the screens that exist. Each link is a plain path (the shell renders it without prefetch). */
export function navigationFor(agencyId: string, implemented: ReadonlySet<string> = IMPLEMENTED_SCREENS): readonly { readonly screen: string; readonly label: MessageId; readonly href: string }[] {
  return AGENCY_NAVIGATION.filter((entry) => implemented.has(entry.screen)).map((entry) => ({ ...entry, href: pathOf(entry.screen, { agencyId }) }));
}

const MAX_RETURN_PATH = 512;

/**
 * The only paths sign-in may send a person back to: a plain path of an APP or OPS screen of this application (an OPS path is served only on
 * the ops host, whose sign-in is the one that sends the person back to it). No scheme, host, query, fragment,
 * backslash, control character, dot segment or encoded separator; never the sign-in screen itself. Anything else is null, and the caller
 * sends the person to the agency switcher instead. (An open redirect after login is a phishing surface: 08 "Browser, API and cache isolation".)
 */
export function safeReturnPath(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_RETURN_PATH) return null;
  if (!/^\/[A-Za-z0-9_\-/]*$/.test(candidate)) return null;
  if (candidate.includes("//") || (candidate.length > 1 && candidate.endsWith("/"))) return null;
  const match = matchRoute(candidate);
  if (match === null || match.screen.origin === "PUBLIC" || match.screen.id === "UI50") return null;
  return candidate;
}

/** The sign-in address for a person who was on `pathname`: the return path travels only when it is one the allowlist accepts. */
export function signInHref(pathname: string): string {
  const back = safeReturnPath(pathname);
  return back === null ? "/login" : `/login?return=${encodeURIComponent(back)}`;
}

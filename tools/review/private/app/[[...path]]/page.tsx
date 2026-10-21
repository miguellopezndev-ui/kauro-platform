// The application as the owner walks it (Order 11): every private screen at its real path on the review origin, for the person the review
// cookie names (or the viewer's query), with the screen's normal state unless the viewer asks for another. Links between screens are the
// application's own paths, so the whole product can be walked like the real one. A path no private screen owns is a not-found.
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { matchRoute } from "@web/screens.ts";
import { AGENCY_ID, COMPANY_ID, CONTEXTS, type ContextKey } from "@review/lib/contexts.ts";
import { FrameHost } from "@review/lib/frame-host.tsx";
import { screenOf } from "@review/lib/inventory.ts";
import { AS_COOKIE } from "@review/lib/links.ts";
import { realPage } from "@review/lib/real-pages.tsx";

type Query = Readonly<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const isPerson = (value: string | undefined): value is ContextKey => value !== undefined && Object.hasOwn(CONTEXTS, value);

/** The screen a path is: a registry screen, or the place where a proposal is drawn. */
function screenAt(pathname: string, person: ContextKey, proposal: string | undefined): { readonly id: string; readonly params: Readonly<Record<string, string>> } | null {
  if (pathname === "/account") return { id: "P-01", params: {} };
  const activity = /^\/agencies\/([^/]+)\/projects\/([^/]+)\/activity$/.exec(pathname);
  if (activity !== null) return { id: "P-08", params: { agencyId: activity[1] ?? "", id: activity[2] ?? "" } };
  if (pathname === "/signup") return { id: "P-05", params: {} };
  if (pathname === "/login/reset") return { id: "P-06", params: {} };
  if (pathname === "/ops/settings") return { id: person === "seller" ? "P-03" : "P-04", params: {} };
  // round 2: the owner's pages the registry does not hold (Sellers, Payouts, Customers, Claims)
  const round2: Readonly<Record<string, string>> = { "/ops/sales/sellers": "P-21", "/ops/money/payouts": "P-22", "/ops/customers": "P-23", "/ops/sales/claims": "P-24" };
  if (round2[pathname] !== undefined) return { id: round2[pathname] as string, params: {} };
  const match = matchRoute(pathname);
  if (match === null || match.screen.origin === "PUBLIC") return null;
  if (proposal === "P-02" && match.screen.id === "UI32") return { id: "P-02", params: match.params };
  if (proposal === "P-07" && match.screen.id === "UI18") return { id: "P-07", params: match.params };
  if (proposal === "P-09" && match.screen.id === "UI30") return { id: "P-09", params: match.params };
  return { id: match.screen.id, params: match.params };
}

export default async function Experience({ params, searchParams }: { readonly params: Promise<{ path?: string[] }>; readonly searchParams: Promise<Query> }) {
  const segments = (await params).path ?? [];
  const pathname = `/${segments.map((segment) => decodeURIComponent(segment)).join("/")}`;
  const query = await searchParams;
  const asked = one(query["review-as"]);
  const stored = (await cookies()).get(AS_COOKIE)?.value;
  const ops = pathname === "/ops" || pathname.startsWith("/ops/");
  const person: ContextKey = isPerson(asked) ? asked : isPerson(stored) ? stored : ops ? "owner" : "agency";
  const found = screenAt(pathname, person, one(query["review-proposal"]));
  if (found === null) notFound();
  const screen = screenOf(found.id);
  if (screen === undefined) notFound();
  const agencyId = found.params["agencyId"] ?? (person === "company" ? COMPANY_ID : AGENCY_ID);
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (one(value) !== undefined && !key.startsWith("review-")) plain[key] = one(value) as string;
  const real = screen.technical === "IMPLEMENTED" ? await realPage(found.id, agencyId, plain, found.params) : null;
  return (
    <FrameHost id={found.id} context={person} state={one(query["review-state"]) ?? "normal"} pathname={pathname}>
      {real}
    </FrameHost>
  );
}

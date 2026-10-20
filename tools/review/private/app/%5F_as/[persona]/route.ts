// Who the review shows the application to (Order 11): /__as/{person} stores the choice for this review origin and opens that person's own
// starting page (or ?next=, a plain application path). It is a review cookie on 127.0.0.1, read only by the review: nothing of the product
// reads it, and it grants nothing (every page still asks the fixture api, which answers as that person).
import { NextResponse, type NextRequest } from "next/server";
import { AGENCY_ID, COMPANY_ID, CONTEXTS } from "@review/lib/contexts.ts";
import { AS_COOKIE } from "@review/lib/links.ts";

const LANDING: Readonly<Record<string, string>> = {
  newcomer: "/agencies",
  agency: "/agencies",
  company: `/agencies/${COMPANY_ID}/projects`,
  admin: `/agencies/${AGENCY_ID}/projects`,
  operator: `/agencies/${AGENCY_ID}/projects`,
  outsider: `/agencies/${AGENCY_ID}/projects`,
  owner: "/ops",
  seller: "/ops",
};

export function GET(request: NextRequest, { params }: { readonly params: Promise<{ persona: string }> }) {
  return params.then(({ persona }) => {
    if (!Object.hasOwn(CONTEXTS, persona)) return new NextResponse("Unknown person.\n", { status: 404 });
    const next = request.nextUrl.searchParams.get("next");
    const target = next !== null && /^\/(?!\/)[A-Za-z0-9/_\-.%?=&]*$/.test(next) ? next : (LANDING[persona] ?? "/agencies");
    const response = new NextResponse(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
    response.cookies.set(AS_COOKIE, persona, { path: "/", sameSite: "lax", httpOnly: true });
    return response;
  });
}

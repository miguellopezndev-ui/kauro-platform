import { THEME_SCRIPT_HEADER, resolveChoice, returnPath, sameOriginWrite, themeCookie, themeOfCookieHeader } from "../../../server/theme.ts";

// POST /preferences/theme (amendment A10): stores the visitor's colour theme as a cookie the server writes. A page with its script running
// posts in the background with THEME_SCRIPT_HEADER and gets 204; a page without script submits the form and is sent back where it was (303).
// A request from another origin changes nothing (403): the preference is harmless, but nothing here acts for a page it did not serve. The
// origin is compared whole, scheme included (sameOriginWrite in server/theme.ts).
export const dynamic = "force-dynamic";

function sameOrigin(request: Request): boolean {
  const header = (name: string): string | null => request.headers.get(name);
  return sameOriginWrite({ url: request.url, origin: header("origin"), host: header("host"), forwardedProto: header("x-forwarded-proto"), forwardedHost: header("x-forwarded-host"), fetchSite: header("sec-fetch-site") });
}

export async function POST(request: Request): Promise<Response> {
  const noStore = { "cache-control": "no-store" };
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers: noStore });
  let choice: string | null = null;
  try {
    const value = (await request.formData()).get("theme");
    choice = typeof value === "string" ? value : null;
  } catch {
    choice = null;
  }
  const theme = resolveChoice(choice, themeOfCookieHeader(request.headers.get("cookie")));
  if (theme === null) return new Response(null, { status: 400, headers: noStore });
  const url = new URL(request.url);
  const cookie = themeCookie(theme, url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https");
  if (request.headers.get(THEME_SCRIPT_HEADER) !== null) return new Response(null, { status: 204, headers: { ...noStore, "set-cookie": cookie } });
  return new Response(null, { status: 303, headers: { ...noStore, "set-cookie": cookie, location: returnPath(url.searchParams.get("return")) } });
}

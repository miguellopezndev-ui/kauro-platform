// Liveness of the web service for the platform's probes (the web counterpart of the api's /livez): answers only that the
// process serves requests; it reads nothing and is never cached.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

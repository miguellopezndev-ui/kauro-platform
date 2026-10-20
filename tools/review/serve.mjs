// The owner's visual review environment (Order 10, "revisión visual interactiva"). It runs on the owner's machine only, bound to 127.0.0.1,
// over plain HTTP, and is never part of the product:
//   - it lives under tools/, outside apps/web, so `next build` never sees it (apps/web/test/review-isolation.test.ts proves the build
//     sources do not reference it);
//   - it serves the REAL standalone build of apps/web (`pnpm --filter @kauro/web run build`), exactly what the container runs, with the real
//     routes, components and stylesheets;
//   - the public capability publication the pages read is the CONTRACT_FAKE of apps/web/e2e/support/public-api.ts (synthetic data, the
//     api's response shape), switchable from the review index;
//   - /__review is the index: every public page with its category (IMPLEMENTED, IMPLEMENTED WITH SYNTHETIC DATA, PROTOTYPE NOT
//     IMPLEMENTED). It is answered by this edge, never by the application, and adds nothing to the application's routes.
//   - /__review/private (Order 11) is the review of the 42 private screens: a separate Next project in tools/review/private that mounts the
//     web's real screens over a fixture fetch and draws the prototypes of the rest, with synthetic data. The edge starts it on its own port
//     and forwards /__review/private to it; the application never sees those requests.
// Usage: node tools/review/serve.mjs   (then open http://127.0.0.1:4400/__review or http://127.0.0.1:4400/__review/private)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const EDGE_PORT = Number(process.env.KAURO_REVIEW_PORT ?? 4400);
const NEXT_PORT = EDGE_PORT + 1;
// EDGE_PORT + 2 is the publication fake's; the private-screen review listens on the next one
const PRIVATE_PORT = EDGE_PORT + 3;
const privateDir = join(import.meta.dirname, "private");
const web = join(import.meta.dirname, "..", "..", "apps", "web");
const server = join(web, ".next", "standalone", "apps", "web", "server.js");
const publicApiModule = join(web, "dist", "e2e", "support", "public-api.js");
for (const [path, what] of [[server, "the standalone build"], [publicApiModule, "the compiled publication fake"]])
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}: run pnpm --filter @kauro/web run build first`);

// the publication fake listens two above the edge (its own arithmetic: KAURO_E2E_PORT + 2)
process.env.KAURO_E2E_PORT = String(EDGE_PORT);
const { startPublicApi, publicApiPort } = await import(pathToFileURL(publicApiModule).href);
const publication = await startPublicApi();
const READINGS = {
  open: [["CLEAN", "AVAILABLE"], ["HUBSPOT", "AVAILABLE"], ["SALESFORCE", "AVAILABLE"]],
  limited: [["CLEAN", "AVAILABLE"], ["HUBSPOT", "AVAILABLE_LIMITED"], ["SALESFORCE", "AVAILABLE_LIMITED"]],
  clean: [["CLEAN", "AVAILABLE"]],
  none: [],
  broken: "BROKEN",
};
let readingName = "open";
publication.publish(READINGS[readingName]);

// the private-screen review: linked to the web's packages, built when it has no build yet (or when asked), then served on its own port
const { linkModules } = await import(pathToFileURL(join(privateDir, "link.mjs")).href);
linkModules();
const nextBin = join(web, "node_modules", "next", "dist", "bin", "next");
const quiet = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
if (process.argv.includes("--rebuild-private") || !existsSync(join(privateDir, ".next", "BUILD_ID"))) {
  console.log("building the private-screen review (tools/review/private) ...");
  const built = spawnSync(process.execPath, [nextBin, "build", privateDir], { stdio: "inherit", env: quiet });
  if (built.status !== 0) throw new Error("the private-screen review did not build");
}
// a fictitious upload origin, so the source intake draws its upload form (nothing is ever sent: the review answers every call itself)
const privateReview = spawn(process.execPath, [nextBin, "start", privateDir, "-p", String(PRIVATE_PORT), "-H", HOST], { stdio: "inherit", env: { ...quiet, NODE_ENV: "production", KAURO_UPLOAD_ORIGIN: "https://uploads.example.test" } });

const next = spawn(process.execPath, [server], {
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production", KAURO_ENV: "LOCAL", KAURO_LOCAL_PUBLICATION_ORIGIN: `http://${HOST}:${publicApiPort()}`, PORT: String(NEXT_PORT), HOSTNAME: HOST },
});

const PAGES = [
  ["Home", "/", "SYNTHETIC", "Real page. The 'Services open' strip reads the synthetic publication."],
  ["How it works", "/how-it-works", "IMPLEMENTED", "Real page; the illustrations use the site's synthetic sample, as in production."],
  ["Supported services", "/supported-services", "SYNTHETIC", "Real page. Availability comes from the synthetic publication (switch below)."],
  ["Pricing", "/pricing", "SYNTHETIC", "Real page and real estimator. Availability comes from the synthetic publication."],
  ["Sample delivery", "/sample-delivery", "IMPLEMENTED", "Real page; its figures are the site's own synthetic sample, labelled as such."],
  ["Data handling", "/security", "IMPLEMENTED", "Real page."],
  ["Contact", "/contact", "SYNTHETIC", "Real form and real validation. No api runs here, so a valid send ends in the real 'could not reach us' state."],
  ["Status", "/status", "SYNTHETIC", "Real page. States come from the synthetic publication (switch below)."],
  ["Help", "/help", "IMPLEMENTED", "Real page."],
  ["Unsubscribe", "/unsubscribe/an-opaque-value-from-a-link", "SYNTHETIC", "Real page with a sample link value. No api runs here, so pressing the button ends in the real failure state."],
  ["Terms (legal)", "/legal/terms", "IMPLEMENTED", "Real route. No operator facts are recorded yet, so it shows the real 'Not published' state (503)."],
  ["Privacy (legal)", "/legal/privacy", "IMPLEMENTED", "Same: the real 'Not published' state."],
  ["Data processing (legal)", "/legal/data-processing", "IMPLEMENTED", "Same: the real 'Not published' state."],
  ["Not found", "/a-page-that-does-not-exist", "IMPLEMENTED", "Real not-found page."],
];
const LABEL = { IMPLEMENTED: "IMPLEMENTED", SYNTHETIC: "IMPLEMENTED WITH SYNTHETIC DATA", PROTOTYPE: "PROTOTYPE NOT IMPLEMENTED" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function index() {
  const rows = PAGES.map(([name, path, cat, note]) => `<tr><td><a href="${path}">${esc(name)}</a><br><code>${esc(path)}</code></td><td><span class="cat cat-${cat}">${LABEL[cat]}</span></td><td>${esc(note)}</td></tr>`).join("");
  const switches = Object.keys(READINGS).map((k) => `<a class="${k === readingName ? "on" : ""}" href="/__review/publication/${k}">${k}</a>`).join(" ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kauro review</title>
<style>:root{color-scheme:light dark;--bg:#f8f6f3;--ink:#242426;--mut:#5e5853;--rule:#ddd5cc;--wine:#653a46}@media (prefers-color-scheme:dark){:root{--bg:#1d1d1f;--ink:#f1ede8;--mut:#b8b0a8;--rule:#3a3a3d;--wine:#c4a693}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{margin:0 0 4px;font-size:24px}p{color:var(--mut);max-width:820px}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--rule);padding:8px;text-align:left;vertical-align:top}a{color:var(--wine)}code{font-size:12px;color:var(--mut)}
.cat{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.04em;border:1px solid}.cat-IMPLEMENTED{color:#1d6b43;border-color:#1d6b43}.cat-SYNTHETIC{color:#7a4d0c;border-color:#7a4d0c}.cat-PROTOTYPE{color:#8a1c2b;border-color:#8a1c2b}
.sw a{display:inline-block;margin:2px 4px 2px 0;padding:3px 10px;border:1px solid var(--rule);border-radius:4px;text-decoration:none}.sw a.on{background:var(--wine);color:var(--bg);border-color:var(--wine)}</style></head><body><main>
<h1>Kauro review — public web</h1>
<p><b>Private screens (Order 11):</b> <a href="/__review/private">all 42 private screens of the application</a>, with synthetic data. The public site's "Sign in" now opens the review's sign-in.</p>
<p>This is the real web of the candidate branch (Order 10), served from the production build on your machine only (<code>127.0.0.1</code>). The pages, components and styles are the product's own. Use the site's own header: the menu, the light/dark switch and every link work as in production. This index is part of the review tool, not of the site.</p>
<p><b>Categories.</b> <span class="cat cat-IMPLEMENTED">IMPLEMENTED</span> real route and components. <span class="cat cat-SYNTHETIC">IMPLEMENTED WITH SYNTHETIC DATA</span> real components fed by an identified fixture; nothing here proves the production backend. <span class="cat cat-PROTOTYPE">PROTOTYPE NOT IMPLEMENTED</span> none on this list.</p>
<p class="sw"><b>Synthetic publication now:</b> ${switches} <br><small>open = all three services available · limited = HubSpot and Salesforce limited · clean = only CLEAN · none = nothing published · broken = the api fails. Reload the page after switching.</small></p>
<table><tr><th>Page</th><th>Category</th><th>What is real here</th></tr>${rows}</table>
<p>Phone view: open the browser's developer tools (F12) and its device toolbar (Ctrl+Shift+M), or narrow the window. Keyboard: Tab from the top of any page; the first stop is the skip link.</p>
</main></body></html>`;
}

// The application's private paths (sign-in, invitation, setup, agencies, operations) are served by the review with synthetic data, so the
// whole product can be walked from the public site; the public pages stay the real build's. The person switch and the review's index too.
const PRIVATE_PREFIXES = ["/login", "/onboarding", "/invitations", "/agencies", "/ops", "/account", "/signup", "/__as", "/__review/private"];
function isPrivate(pathname) {
  return PRIVATE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function forward(req, res, port = NEXT_PORT) {
  const upstream = http.request(
    { hostname: HOST, port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-proto": "http", "x-forwarded-host": req.headers.host ?? `${HOST}:${EDGE_PORT}` } },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("The site is starting or stopped. Wait a few seconds and reload.\n");
  });
  req.pipe(upstream);
}

const edge = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${EDGE_PORT}`);
  if (url.pathname === "/__review" || url.pathname === "/__review/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(index());
    return;
  }
  // the review's own assets: their prefix keeps them apart from the product's /_next
  if (url.pathname.startsWith("/__review/assets/")) {
    req.url = url.pathname.slice("/__review/assets".length) + url.search;
    forward(req, res, PRIVATE_PORT);
    return;
  }
  if (isPrivate(url.pathname)) {
    forward(req, res, PRIVATE_PORT);
    return;
  }
  const m = /^\/__review\/publication\/(\w+)$/.exec(url.pathname);
  if (m && Object.hasOwn(READINGS, m[1])) {
    readingName = m[1];
    publication.publish(READINGS[readingName]);
    res.writeHead(303, { location: "/__review", "cache-control": "no-store" });
    res.end();
    return;
  }
  forward(req, res);
});
edge.listen(EDGE_PORT, HOST, () => console.log(`Kauro review: http://${HOST}:${EDGE_PORT}/__review  (private screens: http://${HOST}:${EDGE_PORT}/__review/private)`));

const stop = () => {
  edge.close();
  next.kill();
  privateReview.kill();
  publication.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
next.on("exit", (code) => {
  console.error(`the site stopped (exit ${code}); restart with: node tools/review/serve.mjs`);
  process.exit(1);
});

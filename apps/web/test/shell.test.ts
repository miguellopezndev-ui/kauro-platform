// The application shell (design D-PRIV-1, D-STATE-1, D-DS-3, D-A11Y-1, D-SEC-1; 11 "Every navigation link resolves to real content or an
// explicitly unavailable feature"). Two layers, tested apart: `viewOf` decides, as data, what the page may draw at each moment; the
// frames render exactly that as markup. The frames are rendered on the server side of React (no browser), which is also how the page's
// first paint is produced, so what is asserted here is what a browser receives before it runs any script.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FetchedResponse } from "../src/client/api-client.ts";
import type { BrowserPage } from "../src/client/browser-session.ts";
import type { SessionPhase } from "../src/client/session.ts";
import { withoutComments } from "../src/copy/lint.ts";
import { AGENCY_NAVIGATION, IMPLEMENTED_SCREENS, pathOf } from "../src/screens.ts";
import type { AgencyContext } from "../src/shell/agency-context.ts";
import { type AnchorComponent, type AnchorProps, ShellFrame } from "../src/shell/frame.tsx";
import { MAIN_ID, PublicFrame } from "../src/shell/landmarks.tsx";
import { createShell, type Shell } from "../src/shell/shell-runtime.ts";
import { type ShellInput, type ShellView, viewOf } from "../src/shell/view.ts";

const AGENCY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1";
const OTHER = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb2";
const PROJECTS = `/agencies/${AGENCY}/projects`;
const SESSION = { userId: "user-1", emailVerified: true, mfaEnrolled: true, mfaAt: null, stepUpFreshUntil: null, idleExpiresAt: "2026-09-29T10:30:00Z", absoluteExpiresAt: "2026-09-29T22:00:00Z" } as const;
const SIGNED_IN: SessionPhase = { kind: "SIGNED_IN", session: SESSION };
const READY: AgencyContext = { kind: "READY", agencyId: AGENCY, displayName: "Northwind Data", state: "ACTIVE" };
const ALL = new Set(["UI10", ...AGENCY_NAVIGATION.map((entry) => entry.screen)]);
const webRoot = fileURLToPath(new URL("../../", import.meta.url));

function input(overrides: Partial<ShellInput> = {}): ShellInput {
  return { phase: SIGNED_IN, agency: READY, pathname: PROJECTS, activeAgency: AGENCY, implemented: ALL, ...overrides };
}

const noop = (): void => undefined;
const ACTIONS = { signOut: noop, checkAgain: noop };
const PRIVATE_CONTENT = "PRIVATE-SCREEN-CONTENT";

function render(view: ShellView, Anchor?: AnchorComponent): string {
  const child = createElement("p", null, PRIVATE_CONTENT);
  const frame: ReactElement = createElement(ShellFrame, { view, actions: ACTIONS, ...(Anchor === undefined ? {} : { Anchor }), children: child });
  return renderToStaticMarkup(frame);
}

// ---- what the page may draw (viewOf) ----

test("D-PRIV-1, D-STATE-1: a private screen's content is drawn only while the session is confirmed; every other phase is a message, and only a refusal offers a control", () => {
  const cases: ReadonlyArray<readonly [SessionPhase, unknown]> = [
    [{ kind: "CHECKING" }, { kind: "WAIT", message: "shell.session.checking.body" }],
    [{ kind: "LEAVING" }, { kind: "WAIT", message: "shell.session.leaving.body" }],
    [{ kind: "SWITCHING", agencyId: OTHER }, { kind: "WAIT", message: "shell.session.switching.body" }],
    [{ kind: "SIGNED_OUT" }, { kind: "REFUSED", title: "shell.session.signed-out.title", body: "shell.session.signed-out.body", action: { kind: "SIGN_IN", href: `/login?return=${encodeURIComponent(PROJECTS)}` } }],
    [{ kind: "UNAVAILABLE", reason: "NO_ANSWER" }, { kind: "REFUSED", title: "shell.session.unavailable.title", body: "shell.session.unavailable.body", action: { kind: "CHECK_AGAIN" } }],
    [{ kind: "UNAVAILABLE", reason: "REJECTED" }, { kind: "REFUSED", title: "shell.session.unavailable.title", body: "shell.session.unavailable.body", action: { kind: "CHECK_AGAIN" } }],
    [{ kind: "UNAVAILABLE", reason: "INTEGRITY" }, { kind: "REFUSED", title: "shell.session.unavailable.title", body: "shell.session.unavailable.body", action: { kind: "CHECK_AGAIN" } }],
    [{ kind: "UNAVAILABLE", reason: "SIGN_OUT_UNCONFIRMED" }, { kind: "REFUSED", title: "shell.session.sign-out-failed.title", body: "shell.session.sign-out-failed.body", action: { kind: "SIGN_OUT" } }],
    [SIGNED_IN, { kind: "OPEN" }],
  ];
  for (const [phase, gate] of cases) assert.deepEqual(viewOf(input({ phase })).gate, gate, phase.kind + (phase.kind === "UNAVAILABLE" ? `/${phase.reason}` : ""));
  // no name, no navigation and no sign-out control before the session is confirmed, whatever the agency context holds
  for (const phase of cases.map(([candidate]) => candidate).filter((candidate) => candidate.kind !== "SIGNED_IN")) {
    const view = viewOf(input({ phase }));
    assert.equal(view.agency, null, phase.kind);
    assert.deepEqual(view.navigation, [], phase.kind);
    assert.equal(view.signOut, false, phase.kind);
    assert.equal(view.switchHref, null, phase.kind);
  }
});

test("D-PRIV-1: an anonymous screen is never held back by the session and carries no private chrome; a private screen outside an agency needs only the session", () => {
  for (const pathname of ["/login", "/invitations/abc123", "/pricing", "/legal/terms"]) {
    for (const phase of [{ kind: "CHECKING" }, { kind: "SIGNED_OUT" }, SIGNED_IN, { kind: "UNAVAILABLE", reason: "NO_ANSWER" }] as const) {
      const view = viewOf(input({ phase, pathname, activeAgency: null, agency: { kind: "NONE" } }));
      assert.deepEqual(view.gate, { kind: "OPEN" }, `${pathname} ${phase.kind}`);
      assert.equal(view.signOut, false, `${pathname} ${phase.kind}`);
      assert.equal(view.agency, null);
    }
  }
  const agencies = viewOf(input({ pathname: "/agencies", activeAgency: null, agency: { kind: "NONE" } }));
  assert.deepEqual(agencies.gate, { kind: "OPEN" });
  assert.equal(agencies.signOut, true);
  assert.equal(agencies.agency, null, "outside an agency there is no agency indicator");
  assert.deepEqual(agencies.navigation, []);
  assert.deepEqual(viewOf(input({ phase: { kind: "CHECKING" }, pathname: "/agencies", activeAgency: null, agency: { kind: "NONE" } })).gate, { kind: "WAIT", message: "shell.session.checking.body" });
});

test("D-PRIV-1, D-STATE-1: inside an agency the content waits for the agency, and a refusal, a stranger's agency or a lost answer is the same single message with Check again", () => {
  assert.deepEqual(viewOf(input({ agency: { kind: "LOADING" } })).gate, { kind: "WAIT", message: "shell.agency.loading.body" });
  assert.equal(viewOf(input({ agency: { kind: "LOADING" } })).agency, null, "no name while it is not confirmed");
  const refused = viewOf(input({ agency: { kind: "UNAVAILABLE" } }));
  assert.deepEqual(refused.gate, { kind: "REFUSED", title: "state.DENIED.title", body: "shell.agency.unavailable.body", action: { kind: "CHECK_AGAIN" } });
  assert.equal(refused.agency, null);
  assert.deepEqual(refused.navigation, [], "no navigation into an agency that is not confirmed");
  assert.equal(refused.signOut, true, "the person can still leave");
  // a tenant screen whose agency segment is not an agency id has no agency at all: nothing to ask again
  assert.deepEqual(viewOf(input({ pathname: "/agencies/not-an-agency/projects", activeAgency: null, agency: { kind: "NONE" } })).gate, { kind: "REFUSED", title: "state.DENIED.title", body: "shell.agency.unavailable.body", action: { kind: "NONE" } });
});

test("D-PRIV-1: a client-side navigation into another agency, or out of one, is never drawn: the page waits for the hard navigation", () => {
  for (const pathname of [`/agencies/${OTHER}/projects`, "/agencies", "/onboarding"]) {
    const view = viewOf(input({ pathname }));
    assert.deepEqual(view.gate, { kind: "WAIT", message: "shell.session.switching.body" }, pathname);
    assert.equal(view.agency, null, pathname);
    assert.deepEqual(view.navigation, [], pathname);
  }
  // and into an agency from a page that began outside one
  assert.deepEqual(viewOf(input({ pathname: PROJECTS, activeAgency: null, agency: { kind: "NONE" } })).gate, { kind: "WAIT", message: "shell.session.switching.body" });
});

test("11: the navigation lists only screens whose page exists, marks the current one, and the agency switcher appears only when its screen exists", () => {
  const empty = viewOf(input({ implemented: new Set() }));
  assert.deepEqual(empty.navigation, [], "a build with no screen page has no entry to offer");
  assert.equal(empty.switchHref, null);
  // by default the shell offers exactly the screens the build declares implemented (screens.test.ts holds that declaration to the page files)
  const declared = viewOf({ phase: SIGNED_IN, agency: READY, pathname: PROJECTS, activeAgency: AGENCY });
  assert.deepEqual(
    declared.navigation.map((item) => item.screen),
    AGENCY_NAVIGATION.map((entry) => entry.screen).filter((screen) => IMPLEMENTED_SCREENS.has(screen)),
  );
  assert.equal(declared.switchHref === null, !IMPLEMENTED_SCREENS.has("UI10"));

  const some = viewOf(input({ implemented: new Set(["UI11", "UI12", "UI10"]) }));
  assert.deepEqual(
    some.navigation.map((item) => [item.screen, item.label, item.href, item.current]),
    [
      ["UI11", "nav.projects.label", PROJECTS, true],
      ["UI12", "nav.clients.label", `/agencies/${AGENCY}/clients`, false],
    ],
  );
  assert.equal(some.switchHref, pathOf("UI10"));
  // an operations page has no agency to switch: the switcher is offered on the application origin only
  assert.equal(viewOf(input({ pathname: "/ops/finance", implemented: new Set(["UI10", "UI39"]) })).switchHref, null);
  // a deeper screen of the same section keeps its section current; a sibling section does not
  assert.deepEqual(viewOf(input({ pathname: `${PROJECTS}/p1`, implemented: new Set(["UI11", "UI12"]) })).navigation.map((item) => item.current), [true, false]);
  assert.deepEqual(viewOf(input({ pathname: `/agencies/${AGENCY}/clients`, implemented: new Set(["UI11", "UI12"]) })).navigation.map((item) => item.current), [false, true]);
  // the order is the reference's, and the six entries are the six agency-level screens
  assert.deepEqual(viewOf(input()).navigation.map((item) => item.screen), ["UI11", "UI12", "UI31", "UI30", "UI32", "UI52"]);
  const shown = viewOf(input());
  assert.deepEqual(shown.agency, { name: "Northwind Data", state: "shell.agency.state.ACTIVE.label" });
});

// ---- what is rendered ----

const prefetchOf: Array<AnchorProps["prefetch"]> = [];
const recording: AnchorComponent = ({ href, prefetch, "aria-current": current, children }) => {
  prefetchOf.push(prefetch);
  return createElement("a", { href, "data-recorded": "yes", ...(current === undefined ? {} : { "aria-current": current }) }, children);
};

test("D-A11Y-1, D-PRIV-1: the frame is a skip link first, one banner, one navigation named for what it is, and one main; every navigation link is drawn without prefetch", () => {
  prefetchOf.length = 0;
  const html = render(viewOf(input()), recording);
  assert.ok(html.startsWith(`<a class="kauro-skip-link" href="#${MAIN_ID}">Skip to main content</a>`), "the skip link is the first thing in the document");
  assert.equal((html.match(/<main\b/g) ?? []).length, 1, "one main landmark");
  assert.ok(html.includes(`<main id="${MAIN_ID}" class="kauro-main" tabindex="-1">`), "the skip link's target exists and takes focus");
  assert.equal((html.match(/<header\b/g) ?? []).length, 1);
  assert.equal((html.match(/<nav\b/g) ?? []).length, 1);
  assert.ok(html.includes('<nav class="kauro-shell-nav" aria-label="Workspace navigation">'));
  assert.ok(html.indexOf("<header") < html.indexOf("<nav") && html.indexOf("<nav") < html.indexOf("<main"), "banner, navigation, main");
  assert.ok(html.includes('<a href="' + PROJECTS + '" data-recorded="yes" aria-current="page">Projects</a>'), "the current entry is marked and is a plain link");
  assert.ok(prefetchOf.length >= 7, "the navigation entries, the switcher and nothing else went through the anchor");
  assert.ok(prefetchOf.every((value) => value === false), "no link is prefetched");
  assert.ok(html.includes(PRIVATE_CONTENT), "an open gate draws the screen");
  assert.ok(html.includes('<div role="status" class="kauro-live"></div>'), "the polite live region exists before it has anything to say");
});

test("D-DS-3, D-SEC-1: an agency's name is a text node in <bdi>, never markup, and no frame carries an inline style, a script or raw HTML", () => {
  const hostile = '<img src=x onerror="alert(1)"> & "quotes" </bdi><script>1</script>';
  const html = render(viewOf(input({ agency: { kind: "READY", agencyId: AGENCY, displayName: hostile, state: "RESTRICTED" } })));
  assert.ok(html.includes('<bdi class="kauro-agency-name">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quotes&quot; &lt;/bdi&gt;&lt;script&gt;1&lt;/script&gt;</bdi>'), "escaped, inside the bdi");
  assert.ok(html.includes('<span class="kauro-agency-state">Restricted</span>'));
  assert.ok(html.includes('<span class="kauro-agency-label">Workspace</span>'));
  // the tags of the markup are the frame's own: no script, no image, no inline style and no event attribute on any of them
  const tags = html.match(/<[^>]+>/g) ?? [];
  assert.ok(tags.length > 10);
  for (const tag of tags) assert.match(tag, /^<\/?(?:a|header|span|div|bdi|nav|ul|li|main|button|p)\b/, tag);
  for (const tag of tags) assert.doesNotMatch(tag, /\s(?:style|on[a-z]+)=/i, tag);
  const bare = render(viewOf(input({ phase: { kind: "SIGNED_OUT" } })));
  assert.doesNotMatch(bare, /<script|\sstyle=/i);
  const folder = join(webRoot, "src", "shell");
  const sources = readdirSync(folder).filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"));
  assert.ok(sources.length >= 8, "the scan reads the shell's sources");
  for (const name of sources) {
    const code = withoutComments(readFileSync(join(folder, name), "utf8"));
    assert.doesNotMatch(code, /dangerouslySetInnerHTML|\bstyle\s*=\s*\{|innerHTML|document\.write/, name);
  }
  assert.doesNotMatch(withoutComments(readFileSync(join(folder, "shell.css"), "utf8")), /@import|url\(\s*["']?https?:/i, "the stylesheet loads nothing from anywhere");
});

test("D-STATE-1, D-A11Y-1: while the session is unknown the page says so in the live region and draws no private content, no name and no control; a refusal is one heading with its one next step", () => {
  for (const phase of [{ kind: "CHECKING" }, { kind: "LEAVING" }, { kind: "SWITCHING", agencyId: null }] as const) {
    const html = render(viewOf(input({ phase })));
    assert.ok(!html.includes(PRIVATE_CONTENT), phase.kind);
    assert.doesNotMatch(html, /Northwind|<nav|<button/, phase.kind);
    assert.match(html, /<div role="status" class="kauro-live"><p>[^<]+<\/p><\/div>/, phase.kind);
  }
  const out = render(viewOf(input({ phase: { kind: "SIGNED_OUT" } })), recording);
  assert.ok(!out.includes(PRIVATE_CONTENT));
  assert.ok(out.includes('<h1 id="kauro-refused-title" tabindex="-1">You are signed out</h1>'), "the heading is what takes focus");
  assert.ok(out.includes(`<a href="/login?return=${encodeURIComponent(PROJECTS).replace(/&/g, "&amp;")}" data-recorded="yes">Sign in</a>`), "the way back returns to where the person was");
  assert.equal((out.match(/<button/g) ?? []).length, 0, "signed out offers no sign-out");

  const lost = render(viewOf(input({ phase: { kind: "UNAVAILABLE", reason: "NO_ANSWER" } })));
  assert.ok(lost.includes('<h1 id="kauro-refused-title" tabindex="-1">We could not check your session</h1>'));
  assert.ok(lost.includes('<button type="button" class="kauro-button">Check again</button>'));
  assert.ok(!lost.includes(PRIVATE_CONTENT));

  const stuck = render(viewOf(input({ phase: { kind: "UNAVAILABLE", reason: "SIGN_OUT_UNCONFIRMED" } })));
  assert.ok(stuck.includes("We could not confirm that you signed out"));
  assert.ok(stuck.includes("You may still be signed in"));
  assert.doesNotMatch(stuck, /You are signed out/, "never claims the person is signed out");
  assert.ok(stuck.includes('<button type="button" class="kauro-button">Sign out</button>'), "the one next step is to try again");

  const noAgency = render(viewOf(input({ agency: { kind: "UNAVAILABLE" } })));
  assert.ok(noAgency.includes("This workspace is not available"));
  assert.ok(noAgency.includes('<button type="button" class="kauro-button">Check again</button>'));
  assert.ok(noAgency.includes('<button type="button" class="kauro-button">Sign out</button>'), "and the person can still leave");
});

test("D-A11Y-1: a public screen's frame is the skip link and the one main landmark, and nothing of the private shell", () => {
  const html = renderToStaticMarkup(createElement(PublicFrame, null, createElement("h1", null, "Pricing")));
  assert.equal(html, `<a class="kauro-skip-link" href="#${MAIN_ID}">Skip to main content</a><main id="${MAIN_ID}" class="kauro-main" tabindex="-1"><h1>Pricing</h1></main>`);
});

// ---- composition ----

const TOKEN = "csrf_token_one_0123456789abcdef0123456789ab";
const SESSION_BODY = { userId: "0199c1a2-7b3d-7c4e-8a5f-000000000001", emailVerified: true, mfaEnrolled: true, mfaAt: "2026-09-29T10:00:00Z", stepUpFreshUntil: null, idleExpiresAt: "2026-09-29T10:30:00Z", absoluteExpiresAt: "2026-09-29T22:00:00Z", csrfToken: TOKEN };
const AGENCY_BODY = { kind: "READ", data: { agencyId: AGENCY, version: 3, displayName: "Northwind Data", state: "ACTIVE", createdAt: "2026-09-01T09:00:00Z", permittedActions: ["VIEW"] } };

/** A scripted browser: the fetch answers by method and path (or waits for the test), and the log records every request and every navigation. */
function browser(pathname: string) {
  const sent: Array<{ readonly url: string; readonly method: string; readonly headers: Readonly<Record<string, string>> }> = [];
  const navigations: string[] = [];
  const answers = new Map<string, () => Promise<FetchedResponse>>();
  const json = (status: number, body: unknown): FetchedResponse => ({ status, headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(body) });
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let counter = 0;
  const page: BrowserPage = {
    fetch: async (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers });
      const answer = answers.get(`${init.method} ${url}`);
      if (answer === undefined) throw new TypeError(`unscripted ${init.method} ${url}`);
      return answer();
    },
    location: { pathname, assign: (url) => navigations.push(`assign:${url}`), replace: (url) => navigations.push(`replace:${url}`) },
    window: win,
    document: doc,
    now: () => 1_790_000_000_000,
    randomBytes: (length) => Uint8Array.from({ length }, () => (counter += 1)),
  };
  return { page, sent, navigations, answers, json, win };
}

async function settled(shell: Shell, done: () => boolean): Promise<void> {
  if (done()) return;
  await new Promise<void>((resolve) => {
    const unsubscribers = [shell.session.subscribe(() => check()), shell.agency.subscribe(() => check())];
    function check(): void {
      if (!done()) return;
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve();
    }
  });
}

test("D-PRIV-1, D-STATE-1: the composed shell reads the session, then asks for the agency the URL names, and a view of it holds back everything until both are confirmed", async () => {
  const world = browser(PROJECTS);
  let releaseAgency: () => void = () => undefined;
  const agencyReply = new Promise<void>((resolve) => {
    releaseAgency = resolve;
  });
  world.answers.set("GET /api/v1/sessions/current", async () => world.json(200, SESSION_BODY));
  world.answers.set(`GET /api/v1/agencies/${AGENCY}`, async () => {
    await agencyReply;
    return world.json(200, AGENCY_BODY);
  });
  const shell = createShell(world.page);
  const drawn = (): ShellView => viewOf({ phase: shell.session.snapshot(), agency: shell.agency.snapshot(), pathname: PROJECTS, activeAgency: shell.session.activeAgency(), implemented: ALL });
  assert.deepEqual(drawn().gate, { kind: "WAIT", message: "shell.session.checking.body" }, "before anything is read");
  assert.equal(world.sent.length, 0, "creating the shell sends nothing: the page starts it");

  await shell.session.start();
  await settled(shell, () => shell.agency.snapshot().kind === "LOADING");
  assert.deepEqual(drawn().gate, { kind: "WAIT", message: "shell.agency.loading.body" }, "the session is confirmed, the agency is not");
  assert.equal(drawn().agency, null, "no name before the agency answers");
  assert.deepEqual(
    world.sent.map((request) => `${request.method} ${request.url}`),
    ["GET /api/v1/sessions/current", `GET /api/v1/agencies/${AGENCY}`],
  );
  const asked = world.sent[1];
  assert.ok(asked);
  assert.match(asked.headers["X-Correlation-Id"] ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(asked.headers, "X-Kauro-CSRF"), false, "a read carries no token");

  releaseAgency();
  await settled(shell, () => shell.agency.snapshot().kind === "READY");
  assert.deepEqual(drawn().gate, { kind: "OPEN" });
  assert.deepEqual(drawn().agency, { name: "Northwind Data", state: "shell.agency.state.ACTIVE.label" });

  // leaving the page clears what the page knew: nothing of the agency is drawn from a restored page
  world.win.dispatchEvent(new Event("pagehide"));
  assert.equal(shell.session.snapshot().kind, "CHECKING");
  assert.equal(shell.agency.snapshot().kind, "LOADING", "the name is dropped at once, and the context waits for the next confirmation");
  assert.equal(drawn().agency, null);
  assert.deepEqual(drawn().gate, { kind: "WAIT", message: "shell.session.checking.body" });
  shell.detach();
});

test("D-PRIV-1: a shell outside an agency reads no agency, and a session that is not confirmed never asks for one", async () => {
  const outside = browser("/agencies");
  outside.answers.set("GET /api/v1/sessions/current", async () => outside.json(200, SESSION_BODY));
  const shell = createShell(outside.page);
  await shell.session.start();
  assert.equal(shell.session.snapshot().kind, "SIGNED_IN");
  assert.equal(shell.agency.snapshot().kind, "NONE");
  assert.deepEqual(outside.sent.map((request) => request.url), ["/api/v1/sessions/current"]);
  shell.detach();

  const signedOut = browser(PROJECTS);
  signedOut.answers.set("GET /api/v1/sessions/current", async () => signedOut.json(401, { type: "urn:kauro:problem:AUTHENTICATION_REQUIRED", title: "x", status: 401, code: "AUTHENTICATION_REQUIRED", correlationId: AGENCY, retryable: false, nextActions: [] }));
  const anonymous = createShell(signedOut.page);
  await anonymous.session.start();
  assert.equal(anonymous.session.snapshot().kind, "SIGNED_OUT");
  assert.equal(anonymous.agency.snapshot().kind, "LOADING", "inside an agency the context waits; it is never READY without a session");
  assert.equal(viewOf({ phase: anonymous.session.snapshot(), agency: anonymous.agency.snapshot(), pathname: PROJECTS, activeAgency: anonymous.session.activeAgency() }).agency, null);
  assert.deepEqual(signedOut.sent.map((request) => request.url), ["/api/v1/sessions/current"], "no agency is read without a session");
  anonymous.detach();
});

test("Order 11: inside a project the menu nests its areas for its service; a destination and an import exist only for HubSpot and Salesforce", () => {
  const project = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa2";
  const built = new Set([...ALL, "UI13", "UI14", "UI17", "UI18", "UI19", "UI23", "UI26", "UI27", "UI29"]);
  const input = (mode: "CLEAN" | "HUBSPOT", path: string): ShellInput => ({ phase: SIGNED_IN, agency: READY, pathname: path, activeAgency: AGENCY, implemented: built, project: { projectId: project, name: "Contacts and companies", clientLabel: "Larch Studio", mode } });
  const audit = pathOf("UI18", { agencyId: AGENCY, id: project });
  const hubspot = viewOf(input("HUBSPOT", audit)).project;
  assert.deepEqual(hubspot?.areas.map((area) => area.key), ["overview", "files", "destination", "check", "plan", "purchase", "delivery", "import", "data"]);
  assert.equal(hubspot?.areas.find((area) => area.current)?.key, "check");
  const clean = viewOf(input("CLEAN", audit)).project;
  assert.deepEqual(clean?.areas.map((area) => area.key), ["overview", "files", "check", "plan", "purchase", "delivery", "data"]);
  // a project the page does not name, or a page outside every project, nests nothing
  assert.equal(viewOf({ ...input("HUBSPOT", PROJECTS), project: { projectId: project, name: "x", clientLabel: "y", mode: "HUBSPOT" } }).project, null);
  const markup = renderToStaticMarkup(createElement(ShellFrame, { view: viewOf(input("CLEAN", audit)), actions: { signOut: () => undefined, checkAgain: () => undefined }, children: null }));
  assert.match(markup, /Contacts and companies/);
  assert.doesNotMatch(markup, />Import</);
});

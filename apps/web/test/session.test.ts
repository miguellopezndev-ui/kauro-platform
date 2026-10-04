// The session and privacy runtime (design D-PRIV-1, D-AUTH-4; S067's browser half). The oracle is the design's own sentences: what the
// page may draw at each moment, what is cleared before what happens next, and that nothing reaches a browser store. Time and the network
// are scripted: an answer arrives when the test says so, and a phase is awaited by subscribing to it, never by sleeping.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Problem } from "../src/api/generated.ts";
import type { ApiAnswer } from "../src/client/answer.ts";
import type { FetchedResponse, FetchInit } from "../src/client/api-client.ts";
import { type BrowserPage, createBrowserSession } from "../src/client/browser-session.ts";
import { bindPageEvents, type SessionPhase, SessionRuntime } from "../src/client/session.ts";
import type { SessionApi, SessionView } from "../src/client/session-api.ts";
import { withoutComments } from "../src/copy/lint.ts";

const AGENCY_A = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1";
const AGENCY_B = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb2";
const CORRELATION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99";
const TOKEN_1 = "csrf_token_one_0123456789abcdef0123456789ab";
const TOKEN_2 = "csrf_token_two_0123456789abcdef0123456789ab";
const webRoot = fileURLToPath(new URL("../../", import.meta.url));

const USER_1 = "0199c1a2-7b3d-7c4e-8a5f-000000000001";
const USER_2 = "0199c1a2-7b3d-7c4e-8a5f-000000000002";

function view(userId = USER_1, csrfToken = TOKEN_1): SessionView {
  return { userId, emailVerified: true, mfaEnrolled: true, mfaAt: "2026-09-29T10:00:00Z", stepUpFreshUntil: null, idleExpiresAt: "2026-09-29T10:30:00Z", absoluteExpiresAt: "2026-09-29T22:00:00Z", csrfToken };
}

const replied = (body: SessionView): ApiAnswer<SessionView> => ({ kind: "REPLY", status: 200, correlationId: CORRELATION, body });
const problemOf = (status: number, code: Problem["code"]): Problem => ({ type: `urn:kauro:problem:${code}`, title: "x", status, code, correlationId: CORRELATION, retryable: false, nextActions: [] });
const unauthenticated = (): ApiAnswer<never> => ({ kind: "PROBLEM", status: 401, correlationId: CORRELATION, problem: problemOf(401, "AUTHENTICATION_REQUIRED") });
const refused = (status: number): ApiAnswer<never> => ({ kind: "PROBLEM", status, correlationId: CORRELATION, problem: problemOf(status, "INTERNAL_ERROR") });
const lost = (): ApiAnswer<never> => ({ kind: "NO_ANSWER", reason: "NETWORK", status: null });
const skewed = (status = 200): ApiAnswer<never> => ({ kind: "INTEGRITY", status, correlationId: CORRELATION, failure: "REPLY_FAILED_CONTRACT" });
const revoked = (): ApiAnswer<undefined> => ({ kind: "REPLY", status: 204, correlationId: CORRELATION, body: undefined });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A scripted api: every call waits until the test answers it, and everything that happens is written to one shared log. */
function scripted(initialPathname = `/agencies/${AGENCY_A}/projects`) {
  const log: string[] = [];
  const reads: Array<Deferred<ApiAnswer<SessionView>>> = [];
  const revokes: Array<Deferred<ApiAnswer<undefined>>> = [];
  const tokenAtRevoke: Array<string | null> = [];
  const holder: { runtime: SessionRuntime | null } = { runtime: null };
  const api: SessionApi = {
    current: () => {
      log.push("api:current");
      const call = deferred<ApiAnswer<SessionView>>();
      reads.push(call);
      return call.promise;
    },
    revoke: () => {
      log.push("api:revoke");
      tokenAtRevoke.push(holder.runtime?.csrfToken() ?? null);
      const call = deferred<ApiAnswer<undefined>>();
      revokes.push(call);
      return call.promise;
    },
  };
  const runtime = new SessionRuntime({
    api,
    navigation: {
      assign: (url) => log.push(`assign:${url}`),
      replace: (url) => log.push(`replace:${url}`),
    },
    initialPathname,
  });
  holder.runtime = runtime;
  runtime.subscribe(() => log.push(`phase:${runtime.snapshot().kind}`));
  const answerRead = (answer: ApiAnswer<SessionView>): void => {
    const call = reads.shift();
    assert.ok(call, "no read is waiting for an answer");
    call.resolve(answer);
  };
  const answerRevoke = (answer: ApiAnswer<undefined>): void => {
    const call = revokes.shift();
    assert.ok(call, "no revoke is waiting for an answer");
    call.resolve(answer);
  };
  return { runtime, log, answerRead, answerRevoke, tokenAtRevoke, waiting: () => reads.length };
}

/** Resolves when the runtime's phase satisfies the predicate (immediately if it already does). */
function until(runtime: SessionRuntime, wanted: (phase: SessionPhase) => boolean): Promise<SessionPhase> {
  return new Promise((resolve) => {
    if (wanted(runtime.snapshot())) {
      resolve(runtime.snapshot());
      return;
    }
    const stop = runtime.subscribe(() => {
      if (wanted(runtime.snapshot())) {
        stop();
        resolve(runtime.snapshot());
      }
    });
  });
}

async function signedIn(initialPathname?: string, body: SessionView = view()) {
  const world = scripted(initialPathname);
  const started = world.runtime.start();
  world.answerRead(replied(body));
  await started;
  assert.equal(world.runtime.snapshot().kind, "SIGNED_IN");
  world.log.length = 0;
  return world;
}

test("D-PRIV-1: a page draws nothing private until the session is read, and the page sees the session without its token", async () => {
  const world = scripted();
  assert.deepEqual(world.runtime.snapshot(), { kind: "CHECKING" }, "the first phase is the loading shell");
  assert.equal(world.runtime.csrfToken(), null);
  const started = world.runtime.start();
  assert.deepEqual(world.runtime.snapshot(), { kind: "CHECKING" }, "still the shell while the read is out");
  world.answerRead(replied(view()));
  await started;
  const phase = world.runtime.snapshot();
  assert.equal(phase.kind, "SIGNED_IN");
  assert.equal(world.runtime.csrfToken(), TOKEN_1, "the api client can read the token");
  assert.equal(JSON.stringify(phase).includes(TOKEN_1), false, "no phase, and so no component, holds the token");
  assert.equal(JSON.stringify(phase).includes("csrf"), false);
  assert.equal(world.runtime.activeAgency(), AGENCY_A, "the agency is the one in the URL the page was loaded with");
  assert.equal(scripted("/agencies").runtime.activeAgency(), null, "the switcher page is outside every agency");
  assert.equal(scripted("/login").runtime.activeAgency(), null);
  assert.equal(scripted("/agencies/not-a-uuid/projects").runtime.activeAgency(), null, "an agency that is not an id is no agency");
});

test("D-PRIV-1: pagehide wipes the private view before the page is frozen, and an answer that was still on its way is ignored", async () => {
  const world = await signedIn();
  world.runtime.onPageHide();
  assert.deepEqual(world.log, ["phase:CHECKING"], "the wipe is synchronous: the shell replaces the view inside the pagehide event");
  assert.equal(world.runtime.csrfToken(), null, "the token goes with the view");
  assert.deepEqual(world.runtime.snapshot(), { kind: "CHECKING" });

  // a read that was out when the page was hidden answers after: it must not redraw the view of a page in the cache
  const late = scripted();
  const reading = late.runtime.start();
  late.runtime.onPageHide();
  late.answerRead(replied(view()));
  await reading;
  assert.deepEqual(late.runtime.snapshot(), { kind: "CHECKING" }, "a stale read never draws");
  assert.equal(late.runtime.csrfToken(), null);
});

test("D-PRIV-1: a page restored from the back/forward cache draws only after the session has been read again; an ordinary pageshow reads nothing", async () => {
  const world = await signedIn();
  world.runtime.onPageHide();
  assert.deepEqual(await world.runtime.onPageShow(false), undefined, "a first load is not a restore");
  assert.equal(world.waiting(), 0, "an ordinary pageshow makes no call");
  const restoring = world.runtime.onPageShow(true);
  assert.deepEqual(world.runtime.snapshot(), { kind: "CHECKING" }, "nothing is drawn while the read is out");
  assert.deepEqual(world.log, ["phase:CHECKING", "api:current"], "the wipe at pagehide, then one read");
  world.answerRead(replied(view(USER_1, TOKEN_2)));
  await restoring;
  assert.equal(world.runtime.snapshot().kind, "SIGNED_IN");
  assert.equal(world.runtime.csrfToken(), TOKEN_2, "the token is the fresh session's");

  // the session ended while the page sat in the cache
  const ended = await signedIn();
  ended.runtime.onPageHide();
  const back = ended.runtime.onPageShow(true);
  ended.answerRead(unauthenticated());
  await back;
  assert.deepEqual(ended.runtime.snapshot(), { kind: "SIGNED_OUT" }, "a restored page whose session ended never shows its old content");
});

test("D-PRIV-1: a tab that becomes visible reads the session again and reacts: ended, changed hands, unchanged or unknown", async () => {
  const unchanged = await signedIn();
  const first = unchanged.runtime.onBecameVisible();
  assert.equal(unchanged.runtime.snapshot().kind, "SIGNED_IN", "a background read does not blank a page that is showing a confirmed session (edits in memory survive a tab switch)");
  unchanged.answerRead(replied(view(USER_1, TOKEN_2)));
  await first;
  assert.equal(unchanged.runtime.csrfToken(), TOKEN_2, "the session's newest token is used");

  const ended = await signedIn();
  const second = ended.runtime.onBecameVisible();
  ended.answerRead(unauthenticated());
  await second;
  assert.deepEqual(ended.runtime.snapshot(), { kind: "SIGNED_OUT" });
  assert.equal(ended.runtime.csrfToken(), null);

  const handedOver = await signedIn();
  const third = handedOver.runtime.onBecameVisible();
  handedOver.answerRead(replied(view(USER_2, TOKEN_2)));
  await third;
  assert.deepEqual(handedOver.log, ["api:current", "phase:CHECKING", "replace:/agencies"], "another person's session: the page is wiped first, then reloaded from the agency switcher");
  assert.equal(handedOver.runtime.csrfToken(), null);

  const offline = await signedIn();
  const fourth = offline.runtime.onBecameVisible();
  offline.answerRead(lost());
  await fourth;
  assert.equal(offline.runtime.snapshot().kind, "SIGNED_IN", "a blip in the network does not sign the person out");
  const refusedRead = offline.runtime.onBecameVisible();
  offline.answerRead(refused(503));
  await refusedRead;
  assert.equal(offline.runtime.snapshot().kind, "SIGNED_IN");
  const skew = offline.runtime.onBecameVisible();
  offline.answerRead(skewed());
  await skew;
  assert.deepEqual(offline.runtime.snapshot(), { kind: "UNAVAILABLE", reason: "INTEGRITY" }, "a reply that fails the contract is never trusted: the view ends");
  assert.equal(offline.runtime.csrfToken(), null);

  // nothing to re-read in a shell that is already leaving or signed out
  const leaving = await signedIn();
  void leaving.runtime.signOut();
  leaving.log.length = 0;
  await leaving.runtime.onBecameVisible();
  assert.deepEqual(leaving.log, [], "a page that is signing out reads nothing");
});

test("D-PRIV-1: a shell that could not confirm the session stays a shell with its reason, and Check again recovers it", async () => {
  const cases: ReadonlyArray<readonly [string, ApiAnswer<SessionView>, SessionPhase]> = [
    ["no answer", lost(), { kind: "UNAVAILABLE", reason: "NO_ANSWER" }],
    ["a refusal that is not signed-out", refused(503), { kind: "UNAVAILABLE", reason: "REJECTED" }],
    ["a reply that fails the contract", skewed(), { kind: "UNAVAILABLE", reason: "INTEGRITY" }],
    ["a 401 whatever its body", unauthenticated(), { kind: "SIGNED_OUT" }],
    ["a 401 whose body fails the contract", skewed(401), { kind: "SIGNED_OUT" }],
  ];
  for (const [name, answer, expected] of cases) {
    const world = scripted();
    const started = world.runtime.start();
    world.answerRead(answer);
    await started;
    assert.deepEqual(world.runtime.snapshot(), expected, name);
    assert.equal(world.runtime.csrfToken(), null, `${name}: nothing private without a confirmed session`);
  }
  const world = scripted();
  const first = world.runtime.start();
  world.answerRead(lost());
  await first;
  const again = world.runtime.checkAgain();
  assert.deepEqual(world.runtime.snapshot(), { kind: "CHECKING" });
  world.answerRead(replied(view()));
  await again;
  assert.equal(world.runtime.snapshot().kind, "SIGNED_IN");
});

test("D-PRIV-1: a 401 from any call ends the private view; a runtime that is reading, leaving or switching owns its own outcome", async () => {
  const world = await signedIn();
  world.runtime.observeAnswer(refused(500));
  world.runtime.observeAnswer(lost());
  world.runtime.observeAnswer({ kind: "PROBLEM", status: 403, correlationId: CORRELATION, problem: problemOf(403, "NOT_AUTHORIZED") });
  assert.equal(world.runtime.snapshot().kind, "SIGNED_IN", "only a 401 ends the view");
  world.runtime.observeAnswer(unauthenticated());
  assert.deepEqual(world.log, ["phase:SIGNED_OUT"]);
  assert.equal(world.runtime.csrfToken(), null);

  const integrity = await signedIn();
  integrity.runtime.observeAnswer(skewed(401));
  assert.equal(integrity.runtime.snapshot().kind, "SIGNED_OUT");

  const reading = scripted();
  void reading.runtime.start();
  reading.runtime.observeAnswer(unauthenticated());
  assert.deepEqual(reading.runtime.snapshot(), { kind: "CHECKING" }, "the read in flight decides");

  // a background read whose own answer is a 401 ends the view once, and the read's late result does not redraw it
  const background = await signedIn();
  const visible = background.runtime.onBecameVisible();
  background.runtime.observeAnswer(unauthenticated());
  background.answerRead(replied(view()));
  await visible;
  assert.deepEqual(background.runtime.snapshot(), { kind: "SIGNED_OUT" }, "a read that was overtaken never redraws");
});

test("D-PRIV-1: switching agency clears the view, then loads the new agency as a new document; the client router is never used", async () => {
  const world = await signedIn();
  world.runtime.switchAgency(AGENCY_B);
  assert.deepEqual(world.log, ["phase:SWITCHING", `assign:/agencies/${AGENCY_B}/projects`], "the clearing state is set before the navigation is asked for");
  assert.deepEqual(world.runtime.snapshot(), { kind: "SWITCHING", agencyId: AGENCY_B });
  assert.equal(world.runtime.csrfToken(), null, "nothing of the previous agency's session stays in memory");
  assert.equal(world.log.some((line) => line.startsWith("replace:")), false, "an agency switch keeps its history entry");
  assert.throws(() => world.runtime.switchAgency("not-an-agency"), RangeError);
  assert.throws(() => world.runtime.switchAgency(`${AGENCY_B}/../x`), RangeError);
  assert.throws(() => world.runtime.switchAgency(""), RangeError);
  assert.equal(world.log.length, 2, "a refused agency id navigates nowhere");
});

test("D-PRIV-1: a soft navigation that would cross an agency boundary becomes a hard one; inside one agency it stays soft", async () => {
  const world = await signedIn();
  assert.equal(world.runtime.checkAgencyBoundary(`/agencies/${AGENCY_A}/clients`), "SAME_AGENCY");
  assert.equal(world.runtime.checkAgencyBoundary(`/agencies/${AGENCY_A}/projects/p-1/plan/approval`), "SAME_AGENCY");
  assert.deepEqual(world.log, [], "a navigation inside the agency touches nothing");
  assert.equal(world.runtime.checkAgencyBoundary(`/agencies/${AGENCY_B}/projects`), "HARD_NAVIGATION");
  assert.deepEqual(world.log, ["phase:SWITCHING", `assign:/agencies/${AGENCY_B}/projects`]);

  const out = await signedIn();
  assert.equal(out.runtime.checkAgencyBoundary("/agencies"), "HARD_NAVIGATION", "leaving the agency for the switcher resets memory too");
  assert.deepEqual(out.log, ["phase:SWITCHING", "assign:/agencies"]);
  assert.deepEqual(out.runtime.snapshot(), { kind: "SWITCHING", agencyId: null });

  const switcher = await signedIn("/agencies");
  assert.equal(switcher.runtime.checkAgencyBoundary("/onboarding"), "SAME_AGENCY", "two pages outside every agency share no agency");
  assert.equal(switcher.runtime.checkAgencyBoundary(`/agencies/${AGENCY_A}/projects`), "HARD_NAVIGATION", "entering an agency from outside is a new document");

  for (const bad of ["https://elsewhere.test/", "//elsewhere.test/x", "/agencies?x=1", "agencies", "/a/../b", ""]) {
    assert.throws(() => world.runtime.checkAgencyBoundary(bad), RangeError, JSON.stringify(bad));
  }
});

test("D-PRIV-1: sign-out clears the view, asks the api to revoke, and only a confirmed revoke replaces the location with the sign-in page", async () => {
  const world = await signedIn();
  const leaving = world.runtime.signOut();
  assert.deepEqual(world.log, ["phase:LEAVING", "api:revoke"], "the view is cleared before the revoke is asked for");
  assert.deepEqual(world.tokenAtRevoke, [TOKEN_1], "the revoke is an unsafe request: it still had the session's CSRF token");
  assert.equal(world.log.includes("replace:/login"), false, "not before the api has answered");
  world.answerRevoke(revoked());
  assert.equal(await leaving, "LEFT");
  assert.deepEqual(world.log, ["phase:LEAVING", "api:revoke", "replace:/login"]);
  assert.equal(world.runtime.csrfToken(), null);

  // a session that was already gone confirms the same thing: the revoke is idempotent
  const already = await signedIn();
  const gone = already.runtime.signOut();
  already.answerRevoke(unauthenticated());
  assert.equal(await gone, "LEFT");
  assert.equal(already.log.at(-1), "replace:/login");

  // two activations are one revoke
  const twice = await signedIn();
  const a = twice.runtime.signOut();
  const b = twice.runtime.signOut();
  assert.equal(a, b, "the second activation joins the first");
  assert.equal(twice.log.filter((line) => line === "api:revoke").length, 1);
  twice.answerRevoke(revoked());
  assert.equal(await a, "LEFT");
});

test("D-PRIV-1: a sign-out the api did not confirm stays on the page and says so, keeps the ability to try again, and never claims the person is signed out", async () => {
  for (const answer of [lost(), refused(503), skewed(204), { kind: "PROBLEM", status: 403, correlationId: CORRELATION, problem: problemOf(403, "NOT_AUTHORIZED") } as ApiAnswer<undefined>]) {
    const world = await signedIn();
    const leaving = world.runtime.signOut();
    world.answerRevoke(answer);
    assert.equal(await leaving, "UNCONFIRMED", JSON.stringify(answer));
    assert.deepEqual(world.runtime.snapshot(), { kind: "UNAVAILABLE", reason: "SIGN_OUT_UNCONFIRMED" });
    assert.equal(world.log.some((line) => line.startsWith("replace:")), false, "the person may still be signed in: the location does not change");
    assert.equal(world.runtime.csrfToken(), TOKEN_1, "the token is kept, because trying again is another unsafe request");

    world.log.length = 0;
    await world.runtime.onBecameVisible();
    assert.deepEqual(world.log, [], "a tab that comes back does not read over the message");

    const retry = world.runtime.signOut();
    assert.deepEqual(world.log, ["phase:LEAVING", "api:revoke"], "a second attempt is a new revoke");
    world.answerRevoke(revoked());
    assert.equal(await retry, "LEFT");
    assert.equal(world.log.at(-1), "replace:/login");
  }
});

test("D-PRIV-1: a page frozen while signing out or switching starts from the loading shell when it is restored", async () => {
  const world = await signedIn();
  const leaving = world.runtime.signOut();
  world.runtime.onPageHide();
  assert.deepEqual(world.runtime.snapshot(), { kind: "LEAVING" }, "already a shell");
  world.answerRevoke(revoked());
  assert.equal(await leaving, "SUPERSEDED", "the answer of a page that was hidden decides nothing");
  assert.equal(world.log.includes("replace:/login"), false);
  const restored = world.runtime.onPageShow(true);
  assert.deepEqual(world.runtime.snapshot(), { kind: "CHECKING" }, "not stuck in LEAVING");
  world.answerRead(unauthenticated());
  await restored;
  assert.deepEqual(world.runtime.snapshot(), { kind: "SIGNED_OUT" });

  const switching = await signedIn();
  switching.runtime.switchAgency(AGENCY_B);
  switching.runtime.onPageHide();
  const back = switching.runtime.onPageShow(true);
  switching.answerRead(replied(view()));
  await back;
  assert.equal(switching.runtime.snapshot().kind, "SIGNED_IN", "a restored page whose switch never completed shows the agency of its URL again");
});

test("D-PRIV-1: the page's events reach the runtime through the real event names, and unbinding stops them", async () => {
  const world = await signedIn();
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const detach = bindPageEvents(world.runtime, { window: win, document: doc });

  win.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(world.runtime.snapshot(), { kind: "CHECKING" }, "pagehide wipes synchronously, inside the dispatch");

  win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
  assert.equal(world.waiting(), 0, "an ordinary pageshow reads nothing");
  win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  world.answerRead(replied(view()));
  await until(world.runtime, (phase) => phase.kind === "SIGNED_IN");

  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(world.waiting(), 0, "going away is not a reason to read");
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  world.answerRead(unauthenticated());
  await until(world.runtime, (phase) => phase.kind === "SIGNED_OUT");

  detach();
  world.log.length = 0;
  win.dispatchEvent(new Event("pagehide"));
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(world.log, [], "an unbound page is not listened to");
});

/** A scripted browser: the fetch answers by method and path, and the log records what was sent and where the location went. */
function browserWorld(initialPathname = `/agencies/${AGENCY_A}/projects`) {
  const log: string[] = [];
  const sent: Array<{ readonly url: string; readonly init: FetchInit }> = [];
  const answers = new Map<string, () => FetchedResponse>();
  const respond = (status: number, contentType: string | null, body: string): FetchedResponse => {
    const headers = new Map<string, string>(contentType === null ? [] : [["content-type", contentType]]);
    return { status, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, text: async () => body };
  };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let counter = 0;
  const page: BrowserPage = {
    fetch: async (url, init) => {
      sent.push({ url, init });
      const answer = answers.get(`${init.method} ${url}`);
      if (answer === undefined) throw new TypeError(`unscripted ${init.method} ${url}`);
      return answer();
    },
    location: { pathname: initialPathname, assign: (url) => log.push(`assign:${url}`), replace: (url) => log.push(`replace:${url}`) },
    window: win,
    document: doc,
    now: () => 1_790_000_000_000,
    randomBytes: (length) => Uint8Array.from({ length }, () => (counter += 1)),
  };
  const session = createBrowserSession(page);
  session.runtime.subscribe(() => log.push(`phase:${session.runtime.snapshot().kind}`));
  return { ...session, log, sent, answers, respond, win, doc };
}

test("D-PRIV-1, D-AUTH-4: the composed page reads the session through the api client, sends its token on the sign-out, and a 401 from any operation ends the view", async () => {
  const world = browserWorld();
  world.answers.set("GET /api/v1/sessions/current", () => world.respond(200, "application/json", JSON.stringify(view())));
  await world.runtime.start();
  assert.equal(world.runtime.snapshot().kind, "SIGNED_IN");
  const [read] = world.sent;
  assert.ok(read);
  assert.equal(read.init.cache, "no-store");
  assert.equal(read.init.credentials, "same-origin");
  assert.equal(Object.hasOwn(read.init.headers, "X-Kauro-CSRF"), false, "a read carries no token");
  assert.equal(Object.hasOwn(read.init.headers, "X-Kauro-Agency"), false, "the session read is not agency-scoped");
  assert.match(read.init.headers["X-Correlation-Id"] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a UUIDv7 correlation id");

  // any other screen's call: a 401 ends the session's view through the observer
  world.answers.set("GET /api/v1/agencies", () => world.respond(401, "application/problem+json", JSON.stringify(problemOf(401, "AUTHENTICATION_REQUIRED"))));
  const listed = await world.client.call("ListAgencies");
  assert.equal(listed.kind, "PROBLEM");
  assert.deepEqual(world.runtime.snapshot(), { kind: "SIGNED_OUT" });

  // sign-out sends the token, and the location changes only after the 204
  const other = browserWorld();
  other.answers.set("GET /api/v1/sessions/current", () => other.respond(200, "application/json", JSON.stringify(view())));
  await other.runtime.start();
  other.answers.set("POST /api/v1/sessions/current/revoke", () => other.respond(204, null, ""));
  assert.equal(await other.runtime.signOut(), "LEFT");
  const revoke = other.sent.at(-1);
  assert.equal(revoke?.init.method, "POST");
  assert.equal(revoke?.init.headers["X-Kauro-CSRF"], TOKEN_1);
  assert.deepEqual(other.log.slice(-2), ["phase:LEAVING", "replace:/login"], "the view is cleared, then the location is replaced");
});

test("D-AUTH-4: a session reply that is not exactly the session shape is an integrity failure, never a session", async () => {
  const bodies: ReadonlyArray<readonly [string, unknown]> = [
    ["an extra member", { ...view(), role: "OWNER" }],
    ["a missing token", (({ csrfToken: _drop, ...rest }) => rest)(view())],
    ["a token that is not URL-safe", { ...view(), csrfToken: "not url safe !!!!!!!!!!" }],
    ["a date that is not a date", { ...view(), idleExpiresAt: "soon" }],
    ["a user id that is not text", { ...view(), userId: 7 }],
    ["an array", [view()]],
  ];
  for (const [name, body] of bodies) {
    const world = browserWorld();
    world.answers.set("GET /api/v1/sessions/current", () => world.respond(200, "application/json", JSON.stringify(body)));
    await world.runtime.start();
    assert.deepEqual(world.runtime.snapshot(), { kind: "UNAVAILABLE", reason: "INTEGRITY" }, name);
    assert.equal(world.runtime.csrfToken(), null, name);
  }
  // the served SessionView (W2, D-AUTH-4; read through the generated client since the stage-1 integration) always carries both instants,
  // null when unset: a reply without them is not the session shape, and one with them null is a session
  const absent = browserWorld();
  const { mfaAt: _a, stepUpFreshUntil: _b, ...withoutInstants } = view();
  absent.answers.set("GET /api/v1/sessions/current", () => absent.respond(200, "application/json", JSON.stringify(withoutInstants)));
  await absent.runtime.start();
  assert.deepEqual(absent.runtime.snapshot(), { kind: "UNAVAILABLE", reason: "INTEGRITY" }, "the two instants are always sent");
  const unset = browserWorld();
  unset.answers.set("GET /api/v1/sessions/current", () => unset.respond(200, "application/json", JSON.stringify({ ...view(), mfaAt: null, stepUpFreshUntil: null })));
  await unset.runtime.start();
  assert.equal(unset.runtime.snapshot().kind, "SIGNED_IN", "an unset instant is null");
});

// ---- no browser storage (D-PRIV-1) ----

const STORE_WORDS = /\b(localStorage|sessionStorage|indexedDB|IDBFactory|IDBDatabase|cookieStore|BroadcastChannel|serviceWorker)\b|\bdocument\s*\.\s*cookie\b|\bnavigator\s*\.\s*storage\b|\b(window|self|globalThis)\s*\.\s*caches\b|\bcaches\s*\.\s*(open|match|keys|has|delete)\b/;

/** The files of a directory tree with the given extensions, or none when the tree does not exist yet. */
function sourcesUnder(directory: string, extensions: readonly string[]): readonly string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourcesUnder(path, extensions);
    return extensions.some((extension) => entry.endsWith(extension)) ? [path] : [];
  });
}

test("D-PRIV-1: no source that runs in the browser touches a browser store, and the scan finds one when it is there", () => {
  const files = ["client", "shell", "app", "copy"].flatMap((folder) => sourcesUnder(join(webRoot, "src", folder), [".ts", ".tsx"]));
  assert.ok(files.length > 10, "the scan reads the browser sources");
  const offending = files.filter((file) => STORE_WORDS.test(withoutComments(readFileSync(file, "utf8"))));
  assert.deepEqual(offending, [], "private data exists only in the page's memory");
  for (const source of ["localStorage.setItem('k', v)", "window.sessionStorage", "const db = indexedDB.open('x')", "document.cookie = 'a=b'", "await caches.open('v1')", "navigator.serviceWorker.register('/sw.js')", "new BroadcastChannel('x')", "globalThis.caches"]) {
    assert.ok(STORE_WORDS.test(source), source);
  }
  const commented = ["const a = 1;", "// localStorage in a comment is not code", "/* indexedDB too */", ""].join(String.fromCharCode(10));
  assert.equal(STORE_WORDS.test(commented), true, "the raw pattern sees a comment");
  assert.equal(STORE_WORDS.test(withoutComments(commented)), false, "and the scan strips comments first");
});

test("D-PRIV-1: the runtime runs its whole life with every browser store made to throw", async () => {
  const names = ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "BroadcastChannel"];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error(`the runtime touched ${name}`);
      },
    });
  }
  try {
    const world = browserWorld();
    world.answers.set("GET /api/v1/sessions/current", () => world.respond(200, "application/json", JSON.stringify(view())));
    world.answers.set("POST /api/v1/sessions/current/revoke", () => world.respond(204, null, ""));
    await world.runtime.start();
    world.win.dispatchEvent(new Event("pagehide"));
    await world.runtime.onPageShow(true);
    world.runtime.switchAgency(AGENCY_B);
    await world.runtime.onPageShow(true);
    assert.equal(await world.runtime.signOut(), "LEFT");
    world.detach();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
});

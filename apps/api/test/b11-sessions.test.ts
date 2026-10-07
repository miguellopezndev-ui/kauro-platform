// B11 W2 — the session and identity boundary of the api (design docs/design/B11-agency-app.md D-AUTH-1..5; case map
// docs/design/B11-case-map.md S067 and R2-134). Real routes, the real composition root (the session boundary bound by
// assembleApi), a real PostgreSQL 17 cluster with the api's own kauro_app and kauro_assurance pools. The identity provider is
// the contract fake of @kauro/application/testing (ContractFakeIdentityIssuer, labelled CONTRACT_FAKE, evidence class
// SIMULATED): RS256 tokens of the documented Identity Platform claim shape, signed by its own key pair and checked by the
// api's shipped verifier exactly as a live token would be (the same code; only the key source differs, D-AUTH-3). The api's
// clock and the issuer's clock are one test clock: idle and absolute expiry, token ages and step-up freshness move forward
// without anyone sleeping.
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgencyMembershipView, Page } from "@kauro/application";
import { ContractFakeIdentityIssuer, testClock } from "@kauro/application/testing";
import { ROLES, startTemporaryPostgres } from "@kauro/persistence/testing";
import { API_APPLICATION_NAME, ConfigError, assembleApi, bootstrap, createIdentityTokenVerifier, loadConfig, type IdentityTokenVerifierOptions } from "../src/index.js";
import { startFakeIdentityServer } from "./support/fake-identity-server.js";
import { selfSignedCertificatePem } from "./support/x509.js";
import {
  approvalBodyOf,
  asProblem,
  call,
  completed,
  freshKey,
  outcome,
  routes,
  sessionPaths,
  world,
  type BrowserSession,
  type Reply,
  type World,
} from "./support.js";

const clock = testClock();

let w: World;
before(async () => {
  w = await world({ clock, sessions: true });
});
after(async () => {
  await w.stop();
});

const SESSION_VIEW_MEMBERS = ["absoluteExpiresAt", "csrfToken", "emailVerified", "idleExpiresAt", "mfaAt", "mfaEnrolled", "stepUpFreshUntil", "userId"];

/** A browser request under a session: the cookie, the exact app Origin and the session's CSRF token on unsafe methods. */
function browser(s: BrowserSession | null, c: { readonly method?: "GET" | "POST"; readonly url: string; readonly body?: unknown; readonly key?: string | null; readonly agency?: string | null; readonly origin?: string | null; readonly csrf?: string | null; readonly secFetchSite?: string; readonly headers?: Record<string, string> }): Promise<Reply> {
  const method = c.method ?? "POST";
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (s !== null && headers["cookie"] === undefined) headers["cookie"] = s.cookie;
  const origin = c.origin === undefined ? w.identity().origin : c.origin;
  if (origin !== null) headers["origin"] = origin;
  const csrf = c.csrf === undefined ? s?.view.csrfToken ?? null : c.csrf;
  if (method === "POST" && csrf !== null) headers["x-kauro-csrf"] = csrf;
  if (c.secFetchSite !== undefined) headers["sec-fetch-site"] = c.secFetchSite;
  return call(w, {
    method,
    url: c.url,
    token: null,
    key: c.key === undefined ? (method === "POST" && !c.url.startsWith("/api/v1/sessions") && !c.url.startsWith("/api/v1/assurance") ? freshKey("browser") : null) : c.key,
    agency: c.agency === undefined ? null : c.agency,
    contentType: method === "POST" && c.body !== undefined ? "application/json" : null,
    ...(c.body !== undefined ? { body: c.body } : {}),
    headers,
  });
}

/** Every read a signed-in agency owner makes on its own agency, by path and selector. */
function ownerReads(projectId: string): ReadonlyArray<{ readonly url: string; readonly agency: string | null }> {
  return [
    { url: sessionPaths.current, agency: null },
    { url: "/api/v1/agencies", agency: null },
    { url: `/api/v1/agencies/${w.A.agencyId}`, agency: null },
    { url: `/api/v1/agencies/${w.A.agencyId}/members`, agency: null },
    { url: `/api/v1/agencies/${w.A.agencyId}/clients`, agency: null },
    { url: `/api/v1/projects/${projectId}`, agency: w.A.agencyId },
  ];
}

/** The problem body without its correlation id (the one member that differs between two answers to two requests). */
function withoutCorrelation(reply: Reply): string {
  const body = reply.json<Record<string, unknown>>();
  delete body["correlationId"];
  return JSON.stringify(body);
}

function setCookieOf(reply: Reply): string {
  const v = reply.headers["set-cookie"];
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  assert.equal(list.length, 1, "exactly one Set-Cookie");
  return list[0] as string;
}

async function sessionRow(s: BrowserSession): Promise<Record<string, unknown>> {
  const row = await w.row<Record<string, unknown>>("web_sessions", "secret_sha256 = $1", [s.secretSha256]);
  if (row === null) throw new Error("no session row for the cookie");
  return row;
}

// --- the case-map acceptance tests ------------------------------------------------------------------------------------------

test("S067: a revoked or expired session reads nothing — every read with its cookie answers 401, the revoke answer clears the cookie and the site data, is idempotent, and no reply is cacheable", async () => {
  const id = w.identity();
  const { projectId } = await w.project(w.A, w.clientA);
  // signed in: every read of the owner's agency answers with data
  const s = await id.signIn(w.owner);
  for (const r of ownerReads(projectId)) {
    const reply = await browser(s, { method: "GET", url: r.url, agency: r.agency });
    assert.equal(reply.status, 200, `${r.url} while signed in: ${reply.text}`);
  }
  // logout: 204, the cookie cleared with the attributes it was set with, the site's cache, cookies and storage cleared
  const revoked = await browser(s, { url: sessionPaths.revoke });
  assert.equal(revoked.status, 204, revoked.text);
  assert.equal(revoked.text, "");
  assert.equal(setCookieOf(revoked), "__Host-kauro_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  assert.equal(revoked.headers["clear-site-data"], '"cache", "cookies", "storage"');
  const row = await sessionRow(s);
  assert.ok(row["revoked_at"] instanceof Date);
  assert.equal(row["revoke_reason"], "LOGOUT");
  // the next request with the old cookie reads nothing: every read is the same 401, nothing of the previous session in it
  for (const r of ownerReads(projectId)) {
    const reply = await browser(s, { method: "GET", url: r.url, agency: r.agency });
    assert.equal(outcome(w, reply), "401 AUTHENTICATION_REQUIRED -", r.url);
    for (const sentinel of [w.A.agencyId, projectId, w.owner.userId, "Acme Agency"]) assert.ok(!reply.text.includes(sentinel), `${r.url} leaks ${sentinel}`);
  }
  // a command with the old cookie is refused before any effect
  const clientsBefore = await w.count("end_clients");
  assert.equal(outcome(w, await browser(s, { url: routes.createClient(w.A.agencyId), body: { displayName: "After logout", processingAuthorityRef: w.authorityA } })), "401 AUTHENTICATION_REQUIRED -");
  assert.equal(await w.count("end_clients"), clientsBefore);
  // idempotent: a second logout answers exactly the same and changes nothing
  const again = await browser(s, { url: sessionPaths.revoke });
  assert.equal(again.status, 204);
  assert.equal(setCookieOf(again), setCookieOf(revoked));
  assert.equal(again.headers["clear-site-data"], revoked.headers["clear-site-data"]);
  assert.deepEqual(await sessionRow(s), row, "the revocation is recorded once");
  // expired sessions read nothing either: idle (30 minutes without a request) and absolute (12 hours whatever the activity)
  const idle = await id.signIn(w.owner);
  clock.advance(1_800_000);
  for (const r of ownerReads(projectId)) assert.equal(outcome(w, await browser(idle, { method: "GET", url: r.url, agency: r.agency })), "401 AUTHENTICATION_REQUIRED -", `idle ${r.url}`);
  const busy = await id.signIn(w.owner);
  for (let elapsed = 0; elapsed + 1_500_000 < 43_200_000; elapsed += 1_500_000) {
    clock.advance(1_500_000);
    assert.equal((await browser(busy, { method: "GET", url: sessionPaths.current })).status, 200, `active at +${elapsed + 1_500_000} ms`);
  }
  clock.set(Date.parse(busy.view.absoluteExpiresAt));
  for (const r of ownerReads(projectId)) assert.equal(outcome(w, await browser(busy, { method: "GET", url: r.url, agency: r.agency })), "401 AUTHENTICATION_REQUIRED -", `absolute ${r.url}`);
  // an expired session's logout is still the clearing answer
  const expiredLogout = await browser(busy, { url: sessionPaths.revoke });
  assert.equal(expiredLogout.status, 204);
  assert.equal(expiredLogout.headers["clear-site-data"], '"cache", "cookies", "storage"');
  // every reply of this test carried Cache-Control: no-store (the call helper refuses any other), and none set a cookie
  // except sign-in and logout
  assert.equal(revoked.headers["cache-control"], "no-store");
  // the logout is a durable fact of the owner's own identity stream
  const facts = await w.h.oracle.query<{ outcome: string; reason_code: string }>("SELECT outcome, reason_code FROM kauro.security_events WHERE action = 'SESSION_REVOKE' AND actor_id = $1", [w.owner.userId]);
  assert.deepEqual(facts.rows.map((f) => `${f.outcome} ${f.reason_code}`), ["ALLOW SESSION_REVOKED"], "one fact for the one revocation; the repeated and the expired logouts revoked nothing");
});

test("R2-134: a session opened after expiry carries no invitation or acceptance state, and sign-in answers the same for an unknown, a disabled and an existing identity", async () => {
  const id = w.identity();
  // the invitee of agency A has an open invitation it never accepted; its first session expires (absolute lifetime)
  const first = await id.signIn(w.invited);
  clock.set(Date.parse(first.view.absoluteExpiresAt));
  assert.equal(outcome(w, await browser(first, { method: "GET", url: sessionPaths.current })), "401 AUTHENTICATION_REQUIRED -");
  const termsBefore = await w.row<{ terms_version: string | null; privacy_agreement_version: string | null; version: string }>("agencies", "agency_id = $1", [w.A.agencyId]);
  // re-authentication opens a new session: it names the person and the session, nothing else — no invitation, membership,
  // agency or agreement member exists in the view, and its reads show the durable state unchanged
  const second = await id.signIn(w.invited);
  assert.deepEqual(Object.keys(second.view).sort(), SESSION_VIEW_MEMBERS);
  assert.equal(second.view.userId, w.invited.userId);
  assert.notEqual(second.cookie, first.cookie, "a new secret, never the expired one revived");
  const agencies = await browser(second, { method: "GET", url: "/api/v1/agencies" });
  assert.equal(agencies.status, 200);
  assert.deepEqual(agencies.json<{ data: Page<AgencyMembershipView> }>().data.items, [], "an invitation is not a membership, before or after the new session");
  const membership = await w.row<{ state: string; accepted_at: Date | null }>("memberships", "membership_id = $1", [w.invitedMembershipId]);
  assert.equal(membership?.state, "INVITED");
  assert.equal(membership?.accepted_at, null);
  assert.equal(await w.count("membership_invitations", "membership_id = $1 AND consumed_at IS NULL", [w.invitedMembershipId]), 1, "the invitation is neither consumed nor revived: it is exactly as it was");
  assert.deepEqual(await w.row("agencies", "agency_id = $1", [w.A.agencyId]).then((r) => ({ terms_version: r?.["terms_version"], privacy_agreement_version: r?.["privacy_agreement_version"], version: r?.["version"] })), { terms_version: termsBefore?.terms_version, privacy_agreement_version: termsBefore?.privacy_agreement_version, version: termsBefore?.version }, "no agreement was accepted by signing in");
  const sessionColumns = await w.h.oracle.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'kauro' AND table_name = 'web_sessions' ORDER BY column_name");
  for (const c of sessionColumns.rows) assert.ok(!/invit|membership|agency|terms|agreement|privacy/.test(c.column_name), `a session holds no ${c.column_name}`);

  // three people: one the platform has never seen, one it disabled, one it knows
  const unknown = id.account("r2-134-newcomer");
  const disabledPerson = await w.person("r2-134-disabled");
  const disabled = id.account(disabledPerson);
  await w.h.oracle.query("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [disabledPerson.userId]);
  const existing = id.account(w.viewer);
  assert.equal(await w.count("identities", "user_id = $1", [unknown.userId]), 0);
  // a failed sign-in at the identity provider is one answer, whether the e-mail is unknown, disabled or known
  const failures = [unknown, disabled, existing].map((a) => JSON.stringify(id.issuer.signInWithPassword(a.email, "not-the-password")));
  failures.push(JSON.stringify(id.issuer.signInWithPassword("nobody-at-all@example.test", "whatever-password")));
  assert.equal(new Set(failures).size, 1, failures.join("\n"));
  assert.deepEqual(JSON.parse(failures[0] as string), { kind: "REFUSED", code: "INVALID_LOGIN_CREDENTIALS" });
  // a defective token is one api answer for the three of them
  const defective = new Set<string>();
  for (const a of [unknown, disabled, existing]) {
    const reply = await browser(null, { url: sessionPaths.open, body: { idToken: id.issuer.mint(a.uid, { claims: { aud: "another-project" } }) } });
    assert.equal(outcome(w, reply), "401 AUTHENTICATION_REQUIRED IDENTITY_TOKEN_INVALID");
    defective.add(withoutCorrelation(reply));
  }
  assert.equal(defective.size, 1);
  // a valid sign-in is one answer too: 201, the same members, the same flags, the same cookie attributes — nothing says
  // whether the identity was new, disabled or known
  const opened = [];
  for (const a of [unknown, disabled, existing]) opened.push(await id.signInAs(a));
  const shapes = new Set(opened.map((o) => JSON.stringify({ status: o.reply.status, members: Object.keys(o.session.view).sort(), emailVerified: o.session.view.emailVerified, mfaEnrolled: o.session.view.mfaEnrolled, stepUp: o.session.view.stepUpFreshUntil, cookie: setCookieOf(o.reply).replace(/=[A-Za-z0-9_-]{43};/, "=<secret>;") })));
  assert.equal(shapes.size, 1, [...shapes].join("\n"));
  assert.equal(opened[0]?.reply.status, 201);
  // the current required action comes from the reads, only to the person who proved the account: the newcomer has no agency
  // yet, the disabled identity is refused, the known one sees its agency
  const [asUnknown, asDisabled, asExisting] = opened.map((o) => o.session);
  assert.deepEqual((await browser(asUnknown!, { method: "GET", url: "/api/v1/agencies" })).json<{ data: Page<AgencyMembershipView> }>().data.items, []);
  assert.equal(outcome(w, await browser(asDisabled!, { method: "GET", url: "/api/v1/agencies" })), "403 NOT_AUTHORIZED IDENTITY_DISABLED");
  assert.deepEqual((await browser(asExisting!, { method: "GET", url: "/api/v1/agencies" })).json<{ data: Page<AgencyMembershipView> }>().data.items.map((i) => i.agencyId), [w.A.agencyId]);
  // signing in never enables a disabled identity: its security status is the platform's
  assert.equal((await w.row<{ state: string }>("identities", "user_id = $1", [disabledPerson.userId]))?.state, "DISABLED");
});

// --- the mandate's further obligations (B11-mandates.json W2) ----------------------------------------------------------------

test("W2 token defects: every defect of an identity token — shape, algorithm, key, signature, issuer, audience, lifetime, subject — answers the one 401 IDENTITY_TOKEN_INVALID at sign-in and at step-up, byte for byte but the correlation id, and opens nothing", async () => {
  const id = w.identity();
  const account = id.account("w2-defects");
  const issuer = id.issuer;
  const now = Math.floor(clock.nowMs() / 1000);
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  const good = issuer.mint(account.uid);
  const [h, p] = good.split(".") as [string, string, string];
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  const foreign = new ContractFakeIdentityIssuer({ projectId: issuer.projectId, clock, keyId: issuer.keyId });
  foreign.createAccount({ uid: account.uid, email: account.email, password: "unused-password-1", emailVerified: true, totp: true });
  const hmacWithPublicKey = (): string => {
    const header = b64({ alg: "HS256", typ: "JWT", kid: issuer.keyId });
    const body = b64(payload);
    return `${header}.${body}.${createHmac("sha256", issuer.publicKeyPem).update(`${header}.${body}`).digest("base64url")}`;
  };
  const defects: Record<string, string> = {
    "not a JWT": "not-a-token",
    "two segments": `${h}.${p}`,
    "alg none": `${b64({ alg: "none", typ: "JWT" })}.${p}.`,
    "HS256 keyed with the public key": hmacWithPublicKey(),
    "RS512": issuer.mint(account.uid, { header: { alg: "RS512" } }),
    "unknown kid": issuer.mint(account.uid, { header: { kid: "not-a-known-key" } }),
    "no kid": issuer.mint(account.uid, { omitHeader: ["kid"] }),
    "signed by another key under the issuer's kid": foreign.mint(account.uid),
    "tampered payload": `${h}.${b64({ ...payload, sub: "someone-else", user_id: "someone-else" })}.${good.split(".")[2]}`,
    "wrong issuer": issuer.mint(account.uid, { claims: { iss: "https://securetoken.google.com/another-project" } }),
    "wrong audience": issuer.mint(account.uid, { claims: { aud: "another-project" } }),
    "expired": issuer.mint(account.uid, { claims: { iat: now - 7_200, exp: now - 3_600, auth_time: now - 7_200 } }),
    "issued in the future": issuer.mint(account.uid, { claims: { iat: now + 120, auth_time: now } }),
    "authenticated in the future": issuer.mint(account.uid, { claims: { auth_time: now + 120 } }),
    "no exp": issuer.mint(account.uid, { omitClaims: ["exp"] }),
    "no auth_time": issuer.mint(account.uid, { omitClaims: ["auth_time"] }),
    "empty subject": issuer.mint(account.uid, { claims: { sub: "" } }),
    "subject over 128 characters": issuer.mint(account.uid, { claims: { sub: "s".repeat(129) } }),
    "email_verified not a boolean": issuer.mint(account.uid, { claims: { email_verified: "true" } }),
    "idToken over the size bound": `${good}${"A".repeat(9_000)}`,
  };
  const s = await id.signIn(w.approver2);
  const sessionsBefore = await w.count("web_sessions");
  const proofsBefore = await w.count("assurance_proofs");
  const answers = new Set<string>();
  for (const [name, token] of Object.entries(defects)) {
    const opened = await browser(null, { url: sessionPaths.open, body: { idToken: token } });
    const stepUp = await browser(s, { url: sessionPaths.stepUp, body: { idToken: token } });
    for (const [route, reply] of [["sign-in", opened], ["step-up", stepUp]] as const) {
      assert.equal(`${outcome(w, reply)}`, "401 AUTHENTICATION_REQUIRED IDENTITY_TOKEN_INVALID", `${route}: ${name}`);
      assert.equal(reply.headers["set-cookie"], undefined, `${route}: ${name} sets no cookie`);
      answers.add(withoutCorrelation(reply));
    }
  }
  assert.equal(answers.size, 1, [...answers].join("\n"));
  assert.equal(await w.count("web_sessions"), sessionsBefore, "no session was opened");
  assert.equal(await w.count("assurance_proofs"), proofsBefore, "no proof was recorded");
  // the control: the same issuer's well-formed token opens a session, so every refusal above is the defect's
  assert.equal((await browser(null, { url: sessionPaths.open, body: { idToken: good } })).status, 201);
  // an unverified e-mail is not a token defect: the caller proved the account and is told what to do
  const unverified = id.account("w2-unverified", { emailVerified: false });
  const refused = await browser(null, { url: sessionPaths.open, body: { idToken: issuer.mint(unverified.uid) } });
  assert.equal(outcome(w, refused), "403 ASSURANCE_REQUIRED EMAIL_NOT_VERIFIED");
  // a failed sign-in is a durable anonymous fact; the defects never name who or what
  const denied = await w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.security_events WHERE action = 'SESSION_OPEN' AND outcome = 'DENY' AND actor_kind = 'ANONYMOUS' AND reason_code = 'IDENTITY_TOKEN_INVALID'");
  assert.ok(Number(denied.rows[0]?.n) >= Object.keys(defects).length);
});

test("W2 CSRF: an unsafe request authenticated by the session cookie needs the exact app Origin, a same-origin Sec-Fetch-Site and the session's CSRF token — each refusal is decided before the journal, consumes no idempotency key and writes nothing; a cookie beside a bearer token is AMBIGUOUS_CREDENTIALS", async () => {
  const id = w.identity();
  const s = await id.signIn(w.owner);
  const key = freshKey("csrf");
  const body = { displayName: "CSRF client", processingAuthorityRef: w.authorityA };
  const url = routes.createClient(w.A.agencyId);
  const clientsBefore = await w.count("end_clients");
  const refusals: Array<[string, Reply]> = [
    ["no Origin", await browser(s, { url, body, key, origin: null })],
    ["another origin", await browser(s, { url, body, key, origin: "https://evil.example" })],
    ["the app origin with a path", await browser(s, { url, body, key, origin: `${id.origin}/` })],
    ["the app origin over http", await browser(s, { url, body, key, origin: id.origin.replace("https:", "http:") })],
    ["a cross-site fetch", await browser(s, { url, body, key, secFetchSite: "cross-site" })],
    ["a same-site fetch of another subdomain", await browser(s, { url, body, key, secFetchSite: "same-site" })],
    ["no CSRF token", await browser(s, { url, body, key, csrf: null })],
    ["another session's CSRF token", await browser(s, { url, body, key, csrf: (await id.signIn(w.admin)).view.csrfToken })],
    ["a truncated CSRF token", await browser(s, { url, body, key, csrf: s.view.csrfToken.slice(0, 20) })],
  ];
  for (const [name, reply] of refusals) {
    const expected = name.includes("CSRF token") ? "403 NOT_AUTHORIZED CSRF_TOKEN_INVALID" : "403 NOT_AUTHORIZED ORIGIN_REJECTED";
    assert.equal(outcome(w, reply), expected, name);
    assert.equal(await w.journal(key), null, `${name}: the idempotency key is not consumed`);
  }
  assert.equal(await w.count("end_clients"), clientsBefore);
  // each refusal is an anonymous fact of the command: the request is not trusted to be the session's person
  const facts = await w.h.oracle.query<{ reason_code: string; actor_kind: string }>("SELECT reason_code, actor_kind FROM kauro.security_events WHERE action = 'CMD009' AND correlation_id = ANY($1::uuid[]) ORDER BY occurred_at", [refusals.map(([, r]) => String(r.headers["x-correlation-id"]))]);
  assert.equal(facts.rows.length, refusals.length);
  assert.ok(facts.rows.every((f) => f.actor_kind === "ANONYMOUS"));
  // the same key then carries the legitimate request: it executes once
  const ok = completed<{ clientId: string }>(await browser(s, { url, body, key, secFetchSite: "same-origin" }), 201);
  assert.equal((await w.journal(key))?.state, "COMMITTED");
  assert.equal(await w.count("end_clients"), clientsBefore + 1);
  assert.ok(ok.data.clientId);
  // a safe method needs no CSRF token and no Origin
  assert.equal((await browser(s, { method: "GET", url: `/api/v1/agencies/${w.A.agencyId}`, origin: null })).status, 200);
  // a cookie and a bearer token together are ambiguous, for a read and for a command, before anything is decided
  const both = { authorization: `Bearer ${w.owner.token}` };
  assert.equal(outcome(w, await browser(s, { method: "GET", url: "/api/v1/agencies", headers: both })), "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS");
  const ambiguousKey = freshKey("ambiguous");
  assert.equal(outcome(w, await browser(s, { url, body: { ...body, displayName: "Ambiguous" }, key: ambiguousKey, headers: both })), "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS");
  assert.equal(await w.journal(ambiguousKey), null);
  assert.equal(outcome(w, await browser(s, { method: "GET", url: "/api/v1/agencies", headers: { cookie: `${s.cookie}; ${s.cookie}` } })), "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS", "two session cookies");
  // sign-in itself needs the exact app origin (login CSRF)
  const token = await id.freshToken(w.owner);
  assert.equal(outcome(w, await browser(null, { url: sessionPaths.open, body: { idToken: token }, origin: "https://evil.example" })), "403 NOT_AUTHORIZED ORIGIN_REJECTED");
  assert.equal(outcome(w, await browser(null, { url: sessionPaths.open, body: { idToken: token }, origin: null })), "403 NOT_AUTHORIZED ORIGIN_REJECTED");
  // no reply ever carries a CORS header, not even to a preflight
  const preflight = await w.app.inject({ method: "OPTIONS", url: sessionPaths.open, headers: { origin: id.origin, "access-control-request-method": "POST" } });
  const replies = [preflight.headers, ...refusals.map(([, r]) => r.headers)];
  for (const headers of replies) assert.deepEqual(Object.keys(headers).filter((k) => k.startsWith("access-control-")), []);
});

test("W2 revocation: a logout takes effect on the next request of that session — including a command with a key it already used — while the person's other session keeps working", async () => {
  const id = w.identity();
  const tabA = await id.signIn(w.admin);
  const tabB = await id.signIn(w.admin);
  const key = freshKey("revoke");
  const body = { displayName: "Before logout", processingAuthorityRef: w.authorityA };
  completed(await browser(tabA, { url: routes.createClient(w.A.agencyId), body, key }), 201);
  assert.equal((await browser(tabA, { url: sessionPaths.revoke })).status, 204);
  // the very next request of the revoked session: the replay of its own key is not answered, a read is not answered
  assert.equal(outcome(w, await browser(tabA, { url: routes.createClient(w.A.agencyId), body, key })), "401 AUTHENTICATION_REQUIRED -");
  assert.equal(outcome(w, await browser(tabA, { method: "GET", url: sessionPaths.current })), "401 AUTHENTICATION_REQUIRED -");
  // the other session of the same person is its own: it still reads and replays
  assert.equal((await browser(tabB, { method: "GET", url: sessionPaths.current })).status, 200);
  const replay = await browser(tabB, { url: routes.createClient(w.A.agencyId), body, key });
  assert.equal(replay.status, 201);
  assert.equal(replay.json<{ replayed: boolean }>().replayed, true);
  // signing in again from the browser that holds tabB's cookie replaces that session: the old cookie reads nothing afterwards
  const again = await browser(tabB, { url: sessionPaths.open, body: { idToken: await id.freshToken(w.admin) }, csrf: null });
  assert.equal(again.status, 201, again.text);
  assert.equal(outcome(w, await browser(tabB, { method: "GET", url: sessionPaths.current })), "401 AUTHENTICATION_REQUIRED -");
  assert.equal((await sessionRow(tabB))["revoke_reason"], "REPLACED");
});

test("W2 expiry by the test clock: the idle window (1 800 s) restarts with each request, last-seen is written at most once a minute, and the absolute lifetime (43 200 s) ends a session whatever its activity", async () => {
  const id = w.identity();
  const s = await id.signIn(w.viewer);
  const t0 = Date.parse(s.view.idleExpiresAt) - 1_800_000;
  assert.equal(Date.parse(s.view.absoluteExpiresAt), t0 + 43_200_000);
  // 30 s later: answered, but last-seen is not rewritten (at most once a minute)
  clock.set(t0 + 30_000);
  const early = await browser(s, { method: "GET", url: sessionPaths.current });
  assert.equal(early.status, 200);
  assert.equal(((await sessionRow(s))["last_seen_at"] as Date).getTime(), t0);
  // 1 799 s after sign-in: answered, and the idle window restarts from here
  clock.set(t0 + 1_799_000);
  const touched = await browser(s, { method: "GET", url: sessionPaths.current });
  assert.equal(touched.status, 200);
  assert.equal(Date.parse(touched.json<{ idleExpiresAt: string }>().idleExpiresAt), t0 + 1_799_000 + 1_800_000);
  assert.equal(((await sessionRow(s))["last_seen_at"] as Date).getTime(), t0 + 1_799_000);
  // one millisecond before the idle deadline it still reads; at the deadline it reads nothing
  clock.set(t0 + 1_799_000 + 1_799_999);
  assert.equal((await browser(s, { method: "GET", url: sessionPaths.current })).status, 200);
  const after = Date.parse((await browser(s, { method: "GET", url: sessionPaths.current })).json<{ idleExpiresAt: string }>().idleExpiresAt);
  clock.set(after);
  assert.equal(outcome(w, await browser(s, { method: "GET", url: sessionPaths.current })), "401 AUTHENTICATION_REQUIRED -");
  // an expired session is not revived by a later request, and expiry is time, not a revocation
  const row = await sessionRow(s);
  assert.equal(row["revoked_at"], null);
  // the absolute lifetime: a session used every 25 minutes still ends 12 hours after it was opened
  const busy = await id.signIn(w.viewer);
  const opened = Date.parse(busy.view.absoluteExpiresAt) - 43_200_000;
  for (let t = opened + 1_500_000; t < opened + 43_200_000; t += 1_500_000) {
    clock.set(t);
    const reply = await browser(busy, { method: "GET", url: sessionPaths.current });
    assert.equal(reply.status, 200, `at +${t - opened} ms`);
    assert.ok(Date.parse(reply.json<{ idleExpiresAt: string }>().idleExpiresAt) <= opened + 43_200_000, "the idle window never outlives the absolute lifetime");
  }
  clock.set(opened + 43_200_000 - 1);
  assert.equal((await browser(busy, { method: "GET", url: sessionPaths.current })).status, 200);
  clock.set(opened + 43_200_000);
  assert.equal(outcome(w, await browser(busy, { method: "GET", url: sessionPaths.current })), "401 AUTHENTICATION_REQUIRED -");
  // the database refuses a lifetime longer than the policy's (the rule is not only the application's)
  await assert.rejects(
    w.h.oracle.query("UPDATE kauro.web_sessions SET idle_expires_at = absolute_expires_at + interval '1 second' WHERE secret_sha256 = $1", [busy.secretSha256]),
    /web_sessions/,
  );
});

test("W2 step-up: a re-authentication of the session's own person with its second factor, at most 300 s old, is recorded by the authentication boundary as a B06 STEP_UP proof that CMD025 accepts; a stale, single-factor or foreign re-authentication is refused and records nothing", async () => {
  const id = w.identity();
  const { projectId } = await w.project(w.A, w.clientA);
  const plan = await w.approvable(w.A, projectId, "w2-step-up");
  const s = await id.signIn(w.approver);
  assert.equal(s.view.stepUpFreshUntil, null);
  const proofsBefore = await w.count("assurance_proofs");
  // refused: another person's re-authentication, one without a second factor, one older than 300 s
  const other = await id.freshToken(w.admin);
  assert.equal(outcome(w, await browser(s, { url: sessionPaths.stepUp, body: { idToken: other } })), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  const approverAccount = id.account(w.approver);
  const singleFactor = id.issuer.mint(approverAccount.uid, { omitSecondFactor: true });
  assert.equal(outcome(w, await browser(s, { url: sessionPaths.stepUp, body: { idToken: singleFactor } })), "403 ASSURANCE_REQUIRED STEP_UP_MISSING");
  const old = await id.freshToken(w.approver);
  clock.advance(301_000);
  assert.equal(outcome(w, await browser(s, { url: sessionPaths.stepUp, body: { idToken: old } })), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  assert.equal(await w.count("assurance_proofs"), proofsBefore, "a refused step-up records nothing");
  // without a session there is nobody to step up
  assert.equal(outcome(w, await browser(null, { url: sessionPaths.stepUp, body: { idToken: await id.freshToken(w.approver) } })), "401 AUTHENTICATION_REQUIRED -");
  // accepted: a fresh password + TOTP re-authentication of the approver
  const fresh = await id.freshToken(w.approver);
  const stepped = await browser(s, { url: sessionPaths.stepUp, body: { idToken: fresh } });
  assert.equal(stepped.status, 201, stepped.text);
  const proof = stepped.json<{ proofId: string; expiresAt: string }>();
  assert.deepEqual(Object.keys(proof).sort(), ["expiresAt", "proofId"]);
  const row = await w.row<{ user_id: string; kind: string; method: string; issued_at: Date; expires_at: Date }>("assurance_proofs", "proof_id = $1", [proof.proofId]);
  assert.equal(row?.user_id, w.approver.userId);
  assert.equal(row?.kind, "STEP_UP");
  assert.equal(row?.method, "TOTP");
  assert.equal(row?.expires_at.toISOString(), proof.expiresAt);
  assert.equal(row!.expires_at.getTime() - row!.issued_at.getTime(), 900_000, "the B06 freshness window (D-ASSUR-1)");
  const current = await browser(s, { method: "GET", url: sessionPaths.current });
  assert.equal(current.json<{ stepUpFreshUntil: string }>().stepUpFreshUntil, proof.expiresAt);
  // CMD025 accepts the proof under the same session (cookie, exact Origin, CSRF token)
  const approved = await browser(s, { url: routes.approvePlan(plan.planId), agency: w.A.agencyId, body: approvalBodyOf(plan, proof.proofId) });
  assert.equal(approved.status, 201, approved.text);
  assert.equal((await w.row<{ assurance_proof_ref: string }>("approvals", "plan_id = $1", [plan.planId]))?.assurance_proof_ref, proof.proofId);
  // the issuance is a fact of the approver's own stream
  const facts = await w.h.oracle.query<{ outcome: string; reason_code: string; assurance_class: string }>("SELECT outcome, reason_code, assurance_class FROM kauro.security_events WHERE action = 'STEP_UP_ISSUE' AND actor_id = $1 ORDER BY occurred_at", [w.approver.userId]);
  assert.deepEqual(facts.rows.map((f) => `${f.outcome} ${f.reason_code} ${f.assurance_class}`).sort(), ["ALLOW STEP_UP_ISSUED STEP_UP", "DENY STEP_UP_MISSING STEP_UP", "DENY STEP_UP_NOT_OWNED STEP_UP", "DENY STEP_UP_STALE STEP_UP"]);
});

test("W2 boundary: web_sessions belongs to the authentication boundary — the request-handler role only locks and reads the liveness of the session its own transaction presents and never writes it (D-AUTH-1a), and the boundary group reads and updates only the session whose secret hash it presents", async () => {
  const id = w.identity();
  const s = await id.signIn(w.operator);
  const other = await id.signIn(w.operator);
  // D-AUTH-1a (PV1R-07 r4, migration 0047): the request-handler role may lock and read the liveness columns of the one session its own
  // transaction presents for the identity it binds, and nothing else; it never writes a session.
  const app = await w.h.appPool.raw.connect();
  try {
    assert.equal((await app.query("SELECT count(*)::int AS n FROM kauro.web_sessions")).rows[0].n, 0, "request role: no presented secret, no row");
    await assert.rejects(app.query("SELECT session_id FROM kauro.web_sessions"), /permission denied/);
    await assert.rejects(app.query("UPDATE kauro.web_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT'"), /permission denied/);
    await assert.rejects(app.query("DELETE FROM kauro.web_sessions"), /permission denied/);
    const present = "SELECT set_config('kauro.session_sha256', $1, true), set_config('kauro.user_id', $2, true)";
    await app.query("BEGIN");
    await app.query(present, [s.secretSha256, w.operator.userId]);
    const seen = await app.query<{ secret_sha256: string }>("SELECT secret_sha256 FROM kauro.web_sessions FOR SHARE");
    assert.deepEqual(seen.rows.map((r) => r.secret_sha256), [s.secretSha256], "request role: the presented session only");
    await app.query("ROLLBACK");
    await app.query("BEGIN");
    await app.query(present, [s.secretSha256, w.operator.userId]);
    await assert.rejects(app.query("UPDATE kauro.web_sessions SET session_id = gen_random_uuid()"), /row-level security|IMMUTABLE_COLUMN/);
    await app.query("ROLLBACK");
    await app.query("BEGIN");
    await app.query(present, [s.secretSha256, w.owner.userId]);
    assert.equal((await app.query("SELECT count(*)::int AS n FROM kauro.web_sessions")).rows[0].n, 0, "request role: a session presented for another identity is not visible");
    await app.query("ROLLBACK");
  } finally {
    app.release();
  }
  const boundary = await w.h.assurancePool.raw.connect();
  try {
    await boundary.query("BEGIN");
    assert.equal((await boundary.query("SELECT count(*)::int AS n FROM kauro.web_sessions")).rows[0].n, 0, "no presented secret, no row");
    await boundary.query("SELECT set_config('kauro.session_sha256', $1, true)", [s.secretSha256]);
    const visible = await boundary.query<{ secret_sha256: string }>("SELECT secret_sha256 FROM kauro.web_sessions");
    assert.deepEqual(visible.rows.map((r) => r.secret_sha256), [s.secretSha256]);
    const touched = await boundary.query("UPDATE kauro.web_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT'");
    assert.equal(touched.rowCount, 1, "the presented session only");
    await boundary.query("ROLLBACK");
    await boundary.query("BEGIN");
    await boundary.query("SELECT set_config('kauro.session_sha256', $1, true)", [s.secretSha256]);
    await assert.rejects(boundary.query("UPDATE kauro.web_sessions SET user_id = $1", [w.owner.userId]), /permission denied/);
    await boundary.query("ROLLBACK");
    await boundary.query("BEGIN");
    await assert.rejects(boundary.query("DELETE FROM kauro.web_sessions"), /permission denied/);
    await boundary.query("ROLLBACK");
  } finally {
    boundary.release();
  }
  assert.equal((await sessionRow(other))["revoked_at"], null);
  // the secret itself is never stored: only its SHA-256
  const stored = await w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.web_sessions WHERE secret_sha256 = $1", [createHash("sha256").update(Buffer.from(s.secret, "base64url")).digest("hex")]);
  assert.equal(stored.rows[0]?.n, "1");
  const text = await w.h.oracle.query<{ t: string }>("SELECT row_to_json(x)::text AS t FROM kauro.web_sessions x");
  for (const r of text.rows) assert.ok(!r.t.includes(s.secret) && !r.t.includes(other.secret), "no raw secret in any column");
});

test("W2 identity configuration: GET /api/v1/public/identity-config announces the contract fake in LOCAL only; the verifier's key source is CONTRACT_FAKE only in LOCAL and GOOGLE_X509 elsewhere; the configuration refuses anything else by name", async () => {
  const id = w.identity();
  const reply = await browser(null, { method: "GET", url: sessionPaths.identityConfig, origin: null });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json(), { adapter: "CONTRACT_FAKE", projectId: id.issuer.projectId, endpoint: id.endpoint });
  // the fake is never announced outside LOCAL: the composition refuses to assemble it
  const fakeKeys: IdentityTokenVerifierOptions = { projectId: id.issuer.projectId, environment: "SANDBOX", keySource: { kind: "CONTRACT_FAKE", jwks: id.issuer.jwks() } };
  assert.throws(() => createIdentityTokenVerifier(fakeKeys), /CONTRACT_FAKE/);
  assert.throws(
    () => assembleApi({ environment: "SANDBOX", unitOfWork: w.db.unitOfWork, database: w.db, authenticator: { authenticate: async () => null }, sessions: { ...w.identity().assembly, identityConfig: { adapter: "CONTRACT_FAKE", projectId: id.issuer.projectId, endpoint: id.endpoint } } }),
    /CONTRACT_FAKE/,
  );
  const base = { KAURO_ENVIRONMENT: "LOCAL", KAURO_DB_USER: "kauro_api", KAURO_DB_POOL_MAX: "3", KAURO_AUTH_BEARER_TOKENS_FILE: "tokens.json", KAURO_IDENTITY_KEY_SOURCE: "CONTRACT_FAKE", KAURO_IDENTITY_PROJECT_ID: "kauro-local", KAURO_IDENTITY_FAKE_JWKS_FILE: "jwks.json", KAURO_IDENTITY_FAKE_ENDPOINT: "/__kauro-identity", KAURO_APP_ORIGINS: "https://localhost:44300", KAURO_DB_ASSURANCE_USER: "kauro_session", KAURO_DB_ASSURANCE_POOL_MAX: "1" };
  const config = loadConfig(base);
  assert.deepEqual(config.identity, { keySource: "CONTRACT_FAKE", projectId: "kauro-local", appOrigins: ["https://localhost:44300"], fakeJwksFile: "jwks.json", fakeEndpoint: "/__kauro-identity", assuranceDatabase: { user: "kauro_session", poolMax: 1 } });
  const refusedBy = (variable: string) => (e: unknown) => e instanceof ConfigError && e.message.startsWith(`${variable}:`);
  const live = { ...base, KAURO_ENVIRONMENT: "LIVE", KAURO_AUTH_BEARER_TOKENS_FILE: undefined, KAURO_HTTP_TRUSTED_PROXY_HOPS: "1", KAURO_API_CURSOR_KEY_FILE: "cursor.key", KAURO_DB_TLS_CA_FILE: "ca.pem", KAURO_IDENTITY_FAKE_JWKS_FILE: undefined, KAURO_IDENTITY_FAKE_ENDPOINT: undefined };
  assert.throws(() => loadConfig(live), refusedBy("KAURO_IDENTITY_KEY_SOURCE"), "CONTRACT_FAKE outside LOCAL");
  assert.equal(loadConfig({ ...live, KAURO_IDENTITY_KEY_SOURCE: "GOOGLE_X509", KAURO_APP_ORIGINS: "https://app.kauro.example" }).identity?.keySource, "GOOGLE_X509");
  assert.throws(() => loadConfig({ ...live, KAURO_IDENTITY_KEY_SOURCE: "GOOGLE_X509", KAURO_APP_ORIGINS: "http://app.kauro.example" }), refusedBy("KAURO_APP_ORIGINS"), "plain http outside LOCAL");
  for (const bad of ["", "https://app.kauro.example/", "https://app.kauro.example/path", "*", "https://APP.kauro.example", "app.kauro.example", "https://app.kauro.example,"]) {
    assert.throws(() => loadConfig({ ...base, KAURO_APP_ORIGINS: bad }), refusedBy("KAURO_APP_ORIGINS"), JSON.stringify(bad));
  }
  assert.throws(() => loadConfig({ ...base, KAURO_IDENTITY_KEY_SOURCE: "PEM_FILE" }), refusedBy("KAURO_IDENTITY_KEY_SOURCE"));
  assert.throws(() => loadConfig({ ...base, KAURO_IDENTITY_PROJECT_ID: "Not A Project" }), refusedBy("KAURO_IDENTITY_PROJECT_ID"));
  assert.throws(() => loadConfig({ ...base, KAURO_IDENTITY_FAKE_JWKS_FILE: undefined }), refusedBy("KAURO_IDENTITY_FAKE_JWKS_FILE"));
  assert.throws(() => loadConfig({ ...base, KAURO_DB_ASSURANCE_USER: "kauro_api" }), refusedBy("KAURO_DB_ASSURANCE_USER"), "the boundary login is not the request handlers' login");
  // the 07 connection budget: the runtime pool and the boundary pool share the api's four connections
  assert.throws(() => loadConfig({ ...base, KAURO_DB_POOL_MAX: "4" }), refusedBy("KAURO_DB_ASSURANCE_POOL_MAX"));
  assert.throws(() => loadConfig({ ...base, KAURO_DB_ASSURANCE_POOL_MAX: undefined }), refusedBy("KAURO_DB_ASSURANCE_POOL_MAX"));
  // the session boundary is all or nothing: one identity variable without the others is refused by name
  assert.throws(() => loadConfig({ ...base, KAURO_IDENTITY_PROJECT_ID: undefined }), refusedBy("KAURO_IDENTITY_PROJECT_ID"));
  assert.equal(loadConfig({ KAURO_ENVIRONMENT: "LOCAL", KAURO_DB_USER: "kauro_api", KAURO_DB_POOL_MAX: "4", KAURO_AUTH_BEARER_TOKENS_FILE: "tokens.json" }).identity, null, "without the session boundary the B06 edition is unchanged");
  // the api opens its boundary pool as its own verified login of kauro_assurance
  await id.signIn(w.viewer);
  const pools = await w.h.oracle.query<{ usename: string }>("SELECT DISTINCT usename FROM pg_stat_activity WHERE application_name = $1", [`${API_APPLICATION_NAME}-sessions`]);
  assert.deepEqual(pools.rows.map((r) => r.usename), ["kauro_assurance_test"]);
});

test("W2 GOOGLE_X509 key source: Google's securetoken document (kid → PEM certificate) verifies RS256 tokens of the project, is cached for its Cache-Control max-age, is fetched again for an unknown kid at most once per minute, and an unreachable document answers 503, never 401", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334";
  const certificate = selfSignedCertificatePem({ privateKey, publicKey }, "securetoken.system.gserviceaccount.com");
  let document: Record<string, string> = { [kid]: certificate };
  let fetches = 0;
  let reachable = true;
  const fetchDocument = async (url: string): Promise<Response> => {
    fetches += 1;
    assert.equal(url, "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
    if (!reachable) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(document), { status: 200, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "public, max-age=21600, must-revalidate, no-transform" } });
  };
  const verifier = createIdentityTokenVerifier({ projectId: "kauro-sandbox", environment: "SANDBOX", keySource: { kind: "GOOGLE_X509", fetch: fetchDocument }, clock });
  const google = new ContractFakeIdentityIssuer({ projectId: "kauro-sandbox", clock, keyId: kid, keyPair: { privateKey, publicKey } });
  google.createAccount({ uid: "google-user", email: "google-user@example.test", password: "password-google-1", emailVerified: true, totp: true });
  const token = google.mint("google-user");
  const verified = await verifier.verify(token);
  assert.equal(verified.kind, "VERIFIED");
  assert.equal(verified.kind === "VERIFIED" ? verified.token.subject : null, "google-user");
  assert.equal(fetches, 1);
  // cached for max-age: no fetch until 21 600 s have passed
  clock.advance(21_599_000);
  assert.equal((await verifier.verify(google.mint("google-user"))).kind, "VERIFIED");
  assert.equal(fetches, 1);
  clock.advance(1_000);
  assert.equal((await verifier.verify(google.mint("google-user"))).kind, "VERIFIED");
  assert.equal(fetches, 2, "refreshed once max-age elapsed");
  // rotation: a token under a new kid refreshes the document once; a still-unknown kid does not hammer the endpoint
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const newKid = "ffeeddccbbaa00998877665544332211ffeeddcc";
  document = { [kid]: certificate, [newKid]: selfSignedCertificatePem(rotated, "securetoken.system.gserviceaccount.com") };
  const next = new ContractFakeIdentityIssuer({ projectId: "kauro-sandbox", clock, keyId: newKid, keyPair: rotated });
  next.createAccount({ uid: "google-user", email: "google-user@example.test", password: "password-google-1", emailVerified: true, totp: true });
  clock.advance(60_000);
  assert.equal((await verifier.verify(next.mint("google-user"))).kind, "VERIFIED");
  assert.equal(fetches, 3);
  const unknown = await verifier.verify(google.mint("google-user", { header: { kid: "0000000000000000000000000000000000000000" } }));
  assert.deepEqual(unknown, { kind: "REJECTED", defect: "UNKNOWN_KEY" });
  assert.equal(fetches, 3, "an unknown kid within a minute of the last fetch is not fetched again");
  clock.advance(60_000);
  assert.equal((await verifier.verify(google.mint("google-user", { header: { kid: "0000000000000000000000000000000000000000" } }))).kind, "REJECTED");
  assert.equal(fetches, 4);
  // the documented claims: issuer https://securetoken.google.com/<project>, audience <project>
  assert.deepEqual(await verifier.verify(google.mint("google-user", { claims: { iss: "https://securetoken.google.com/kauro-local" } })), { kind: "REJECTED", defect: "ISSUER" });
  // a malformed document or an unreachable endpoint is the key source's failure, not the caller's: UNAVAILABLE
  clock.advance(21_600_000);
  reachable = false;
  assert.deepEqual(await verifier.verify(google.mint("google-user")), { kind: "UNAVAILABLE" });
  reachable = true;
  document = { [kid]: "-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n" };
  clock.advance(60_000);
  assert.deepEqual(await verifier.verify(google.mint("google-user")), { kind: "UNAVAILABLE" });
  // at the route, UNAVAILABLE is a retryable 503 (the caller's credentials were not judged)
  const unavailableApi = assembleApi({
    environment: "LOCAL",
    unitOfWork: w.db.unitOfWork,
    database: w.db,
    authenticator: { authenticate: async () => null },
    validator: w.validator,
    clock,
    sessions: { ...w.identity().assembly, verifier: { verify: async () => ({ kind: "UNAVAILABLE" }) } },
  });
  await unavailableApi.ready();
  try {
    const reply = await unavailableApi.inject({ method: "POST", url: sessionPaths.open, headers: { "content-type": "application/json", origin: w.identity().origin }, payload: JSON.stringify({ idToken: token }) });
    assert.equal(reply.statusCode, 503);
    const problem = asProblem(w, { status: reply.statusCode, headers: reply.headers as Record<string, string>, contentType: String(reply.headers["content-type"]), text: reply.body, json: <T>() => JSON.parse(reply.body) as T });
    assert.equal(problem.code, "CAPACITY_UNAVAILABLE");
    assert.equal(problem.retryable, true);
  } finally {
    await unavailableApi.close();
  }
});

test("W2 contract fake: the fake identity server (CONTRACT_FAKE, SIMULATED) serves the Identity Toolkit subset the browser suite uses — password sign-in with a TOTP second factor, sign-up, e-mail verification, TOTP enrolment, re-authentication, its JWKS and a test clock — and its tokens open api sessions", async () => {
  const id = w.identity();
  const server = await startFakeIdentityServer({ issuer: id.issuer, allowedOrigins: [id.origin] });
  try {
    const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> => {
      const r = await fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: id.origin }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown>, headers: r.headers };
    };
    // every answer names the fake
    const jwks = await fetch(`${server.url}/jwks.json`);
    assert.equal(jwks.headers.get("x-kauro-evidence-class"), "SIMULATED");
    assert.equal(jwks.headers.get("x-kauro-fake"), "CONTRACT_FAKE");
    assert.deepEqual(((await jwks.json()) as { keys: Array<{ kid: string }> }).keys.map((k) => k.kid), [id.issuer.keyId]);
    // sign-up, verification, enrolment
    const email = `fake-${randomUUID()}@example.test`;
    const signedUp = await post("/v1/accounts:signUp", { email, password: "Correct-Horse-9", returnSecureToken: true });
    assert.equal(signedUp.status, 200);
    assert.equal(signedUp.headers.get("access-control-allow-origin"), id.origin);
    const unverified = await browser(null, { url: sessionPaths.open, body: { idToken: signedUp.json["idToken"] } });
    assert.equal(outcome(w, unverified), "403 ASSURANCE_REQUIRED EMAIL_NOT_VERIFIED");
    const oob = await post("/v1/accounts:sendOobCode", { requestType: "VERIFY_EMAIL", idToken: signedUp.json["idToken"] });
    assert.equal(oob.status, 200);
    assert.equal((await post("/__test/verify-email", { email })).status, 200, "the test stands in for the person opening the verification link");
    const relogin = await post("/v1/accounts:signInWithPassword", { email, password: "Correct-Horse-9", returnSecureToken: true });
    const start = await post("/v2/accounts/mfaEnrollment:start", { idToken: relogin.json["idToken"], totpEnrollmentInfo: {} });
    const totp = start.json["totpSessionInfo"] as { sharedSecretKey: string; sessionInfo: string; verificationCodeLength: number; hashingAlgorithm: string; periodSec: number };
    assert.deepEqual([totp.verificationCodeLength, totp.hashingAlgorithm, totp.periodSec], [6, "SHA1", 30]);
    const code = id.issuer.totpCodeOf(totp.sharedSecretKey);
    const enrolled = await post("/v2/accounts/mfaEnrollment:finalize", { idToken: relogin.json["idToken"], displayName: "Authenticator", totpVerificationInfo: { sessionInfo: totp.sessionInfo, verificationCode: code } });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.json));
    // sign-in now needs the second factor; a wrong code and a wrong password are refused without saying which account exists
    const first = await post("/v1/accounts:signInWithPassword", { email, password: "Correct-Horse-9", returnSecureToken: true });
    assert.equal(typeof first.json["mfaPendingCredential"], "string");
    const info = (first.json["mfaInfo"] as Array<{ mfaEnrollmentId: string; totpInfo: object }>)[0]!;
    const wrong = await post("/v2/accounts/mfaSignIn:finalize", { mfaPendingCredential: first.json["mfaPendingCredential"], mfaEnrollmentId: info.mfaEnrollmentId, totpVerificationInfo: { verificationCode: "000000" === code ? "111111" : "000000" } });
    assert.equal(wrong.status, 400);
    assert.deepEqual(wrong.json, { error: { code: 400, message: "INVALID_CODE" } });
    const refusedKnown = await post("/v1/accounts:signInWithPassword", { email, password: "wrong-password", returnSecureToken: true });
    const refusedUnknown = await post("/v1/accounts:signInWithPassword", { email: `nobody-${randomUUID()}@example.test`, password: "wrong-password", returnSecureToken: true });
    assert.deepEqual([refusedKnown.status, refusedKnown.json], [refusedUnknown.status, refusedUnknown.json]);
    assert.deepEqual(refusedKnown.json, { error: { code: 400, message: "INVALID_LOGIN_CREDENTIALS" } });
    const second = await post("/v1/accounts:signInWithPassword", { email, password: "Correct-Horse-9", returnSecureToken: true });
    const finalized = await post("/v2/accounts/mfaSignIn:finalize", { mfaPendingCredential: second.json["mfaPendingCredential"], mfaEnrollmentId: info.mfaEnrollmentId, totpVerificationInfo: { verificationCode: id.issuer.totpCodeOf(totp.sharedSecretKey) } });
    assert.equal(finalized.status, 200, JSON.stringify(finalized.json));
    const opened = await browser(null, { url: sessionPaths.open, body: { idToken: finalized.json["idToken"] } });
    assert.equal(opened.status, 201, opened.text);
    assert.equal(opened.json<{ mfaEnrolled: boolean }>().mfaEnrolled, true);
    // the test clock of the fake moves the tokens' time, and the api (same clock) sees the same instant
    const before = clock.nowMs();
    assert.equal((await post("/__test/clock", { advanceMs: 5_000 })).status, 200);
    assert.equal(clock.nowMs(), before + 5_000);
    // the fake refuses to serve an origin it was not told about
    const foreign = await fetch(`${server.url}/v1/accounts:signInWithPassword`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ email, password: "Correct-Horse-9" }) });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.close();
  }
});

test("W2 deployment path: bootstrap binds the session boundary from the environment — LOCAL with the contract fake's JWKS file signs in, reads and logs out over a real socket; SANDBOX with GOOGLE_X509 starts and announces the Identity Platform adapter; a boundary login outside kauro_assurance refuses the start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kauro-w2-boot-"));
  const freePort = (): Promise<number> =>
    new Promise((resolvePort, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        srv.close(() => resolvePort(typeof address === "object" && address !== null ? address.port : 0));
      });
    });
  try {
    const issuer = new ContractFakeIdentityIssuer({ projectId: "kauro-boot" });
    const jwksFile = join(dir, "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(issuer.jwks()));
    const origin = "https://app.kauro.test";
    const base = {
      KAURO_DB_HOST: "127.0.0.1",
      KAURO_DB_PORT: String(w.h.pg.port),
      KAURO_DB_NAME: ROLES.database,
      KAURO_DB_USER: ROLES.appLogin,
      KAURO_DB_POOL_MAX: "2",
      KAURO_HTTP_HOST: "127.0.0.1",
      KAURO_IDENTITY_PROJECT_ID: "kauro-boot",
      KAURO_APP_ORIGINS: origin,
      KAURO_DB_ASSURANCE_USER: ROLES.assuranceLogin,
      KAURO_DB_ASSURANCE_POOL_MAX: "1",
    };
    const local = await bootstrap({ ...base, KAURO_ENVIRONMENT: "LOCAL", KAURO_HTTP_PORT: String(await freePort()), KAURO_IDENTITY_KEY_SOURCE: "CONTRACT_FAKE", KAURO_IDENTITY_FAKE_JWKS_FILE: jwksFile, KAURO_IDENTITY_FAKE_ENDPOINT: "/__kauro-identity" }, { logger: false });
    try {
      issuer.createAccount({ uid: "w2-boot-person", email: "w2-boot-person@example.test", password: "password-boot-1", emailVerified: true, totp: true });
      const opened = await fetch(`${local.address}/api/v1/sessions`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ idToken: issuer.mint("w2-boot-person") }) });
      assert.equal(opened.status, 201);
      const cookie = /^(__Host-kauro_session=[A-Za-z0-9_-]{43});/.exec(opened.headers.get("set-cookie") ?? "")?.[1];
      assert.ok(cookie !== undefined, "the session cookie");
      const view = (await opened.json()) as { csrfToken: string };
      assert.equal((await fetch(`${local.address}/api/v1/sessions/current`, { headers: { cookie } })).status, 200);
      const config = await fetch(`${local.address}/api/v1/public/identity-config`);
      assert.deepEqual(await config.json(), { adapter: "CONTRACT_FAKE", projectId: "kauro-boot", endpoint: "/__kauro-identity" });
      const logout = await fetch(`${local.address}/api/v1/sessions/current/revoke`, { method: "POST", headers: { cookie, origin, "x-kauro-csrf": view.csrfToken } });
      assert.equal(logout.status, 204);
      assert.equal(logout.headers.get("clear-site-data"), '"cache", "cookies", "storage"');
      assert.equal((await fetch(`${local.address}/api/v1/sessions/current`, { headers: { cookie } })).status, 401);
    } finally {
      await local.close();
    }
    // outside LOCAL the verifier's key source is Google's (live qualification is B15's): the process starts and announces it
    const cursorKey = join(dir, "cursor.key");
    writeFileSync(cursorKey, Buffer.alloc(32, 7));
    // I-2: outside LOCAL the database is reached over verified TLS, so this start runs against a cluster that serves it
    const tlsCluster = await startTemporaryPostgres({ tls: true });
    let sandbox: Awaited<ReturnType<typeof bootstrap>>;
    try {
    sandbox = await bootstrap({ ...base, KAURO_DB_HOST: tlsCluster.tls?.host, KAURO_DB_PORT: String(tlsCluster.port), KAURO_DB_TLS_CA_FILE: tlsCluster.tls?.caFile, KAURO_ENVIRONMENT: "SANDBOX", KAURO_HTTP_PORT: String(await freePort()), KAURO_HTTP_TRUSTED_PROXY_HOPS: "1", KAURO_API_CURSOR_KEY_FILE: cursorKey, KAURO_IDENTITY_KEY_SOURCE: "GOOGLE_X509", KAURO_APP_ORIGINS: "https://app.kauro.example" }, { logger: false });
    try {
      assert.deepEqual(await (await fetch(`${sandbox.address}/api/v1/public/identity-config`)).json(), { adapter: "IDENTITY_PLATFORM", projectId: "kauro-boot" });
    } finally {
      await sandbox.close();
    }
    } finally {
      await tlsCluster.stop();
    }
    // the boundary's login must be a member of kauro_assurance: a request handler's login cannot keep the sessions
    await assert.rejects(
      bootstrap({ ...base, KAURO_ENVIRONMENT: "LOCAL", KAURO_HTTP_PORT: String(await freePort()), KAURO_IDENTITY_KEY_SOURCE: "CONTRACT_FAKE", KAURO_IDENTITY_FAKE_JWKS_FILE: jwksFile, KAURO_DB_ASSURANCE_USER: ROLES.controlLogin }, { logger: false }),
      /member of kauro_assurance/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W2 session view: sign-in answers 201 with the closed SessionView and the __Host- cookie (Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age = the absolute lifetime); the CSRF token is the session secret's HMAC and GET /sessions/current answers the same view", async () => {
  const id = w.identity();
  const { reply, session } = await id.signInAs(id.account(w.billing));
  assert.equal(reply.status, 201);
  assert.match(setCookieOf(reply), /^__Host-kauro_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  assert.deepEqual(Object.keys(session.view).sort(), SESSION_VIEW_MEMBERS);
  assert.equal(session.view.userId, w.billing.userId);
  assert.equal(session.view.emailVerified, true);
  assert.equal(session.view.mfaEnrolled, true);
  assert.equal(typeof session.view.mfaAt, "string");
  assert.equal(session.view.csrfToken, createHmac("sha256", Buffer.from(session.secret, "base64url")).update("kauro-csrf-v1").digest("base64url"));
  assert.equal(Date.parse(session.view.absoluteExpiresAt) - Date.parse(session.view.idleExpiresAt), 43_200_000 - 1_800_000);
  const current = await browser(session, { method: "GET", url: sessionPaths.current });
  assert.equal(current.status, 200);
  assert.deepEqual(current.json(), session.view);
  assert.equal(current.headers["set-cookie"], undefined, "a read never sets a cookie");
  // the SessionView carries no token, subject or secret of the provider or of the session
  for (const forbidden of [session.secret, session.secretSha256, id.account(w.billing).email]) assert.ok(!reply.text.includes(forbidden));
  // sign-in is a durable fact of the person's own stream
  const fact = await w.h.oracle.query<{ outcome: string; reason_code: string; actor_id: string }>("SELECT outcome, reason_code, actor_id FROM kauro.security_events WHERE action = 'SESSION_OPEN' AND correlation_id = $1", [String(reply.headers["x-correlation-id"])]);
  assert.deepEqual(fact.rows, [{ outcome: "ALLOW", reason_code: "SESSION_OPENED", actor_id: w.billing.userId }]);
  // the session probe refuses a cookie beside a bearer token like every route, and records no fact (the page's probe)
  const ambiguous = await browser(session, { method: "GET", url: sessionPaths.current, headers: { authorization: `Bearer ${w.billing.token}` } });
  assert.equal(outcome(w, ambiguous), "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS");
  assert.equal(await w.count("security_events", "correlation_id = $1", [String(ambiguous.headers["x-correlation-id"])]), 0);
  // a query or a body is not part of the probe's closed request
  assert.equal(outcome(w, await browser(session, { method: "GET", url: `${sessionPaths.current}?refresh=1` })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
});

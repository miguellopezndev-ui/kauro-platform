// B11 stage-1 integration (INT-1), the identity contract fake end to end (design §6: W2 owns the issuer and its HTTP server, W3 the web
// adapter; §12 D-W3-8, D-INT1-4). The two halves were built in parallel against the design: W2's server spoke the Identity Toolkit REST
// subset, W3's adapter the pinned `kauro-fake-identity-v1` protocol, and the api announced the fake at an absolute origin the page's
// same-origin transport refuses. This test runs the built halves together, as the local stack wires them: the api's announcement read by
// the web through its generated guard, the web adapter's same-origin transport routed by an edge to W2's server, and every token the
// adapter hands out checked by the api's own verifier. Everything here is labelled CONTRACT_FAKE / SIMULATED: no live provider is involved.
// It reads the built packages (`pnpm run verify` builds before it tests).
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..", "..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const APP_ORIGIN = "https://app.kauro.test";
const ENDPOINT = "/__kauro-identity";
const PROJECT = "kauro-local";

let testing;
let server;
let issuer;
let verifier;
let identity;

/** The page's fetch behind the local edge: a path under the announced endpoint goes to the fake, with the page's Origin; nothing else. */
function edgeFetch(url, init) {
  if (!url.startsWith(`${ENDPOINT}/`)) throw new Error(`the page fetched ${url}, which the edge does not route to the fake`);
  return fetch(`${server.url}${url.slice(ENDPOINT.length)}`, { method: init.method, headers: { ...init.headers, origin: APP_ORIGIN }, body: init.body, redirect: "error" });
}

before(async () => {
  testing = await load("packages/application/dist/src/testing/index.js");
  const { startFakeIdentityServer } = await load("apps/api/dist/test/support/fake-identity-server.js");
  const api = await load("apps/api/dist/src/index.js");
  const contractFake = await load("apps/web/dist/src/client/identity/contract-fake.js");
  const select = await load("apps/web/dist/src/client/identity/select.js");
  issuer = new testing.ContractFakeIdentityIssuer({ projectId: PROJECT });
  server = await startFakeIdentityServer({ issuer, allowedOrigins: [APP_ORIGIN] });
  verifier = api.createIdentityTokenVerifier({ projectId: PROJECT, environment: "LOCAL", keySource: { kind: "CONTRACT_FAKE", jwks: issuer.jwks() } });
  identity = { contractFake, select };
});

after(async () => {
  await server?.close();
});

/** A fresh web adapter, chosen from the api's announcement exactly as a page chooses it. */
function adapter() {
  const config = identity.select.readIdentityConfig({ adapter: "CONTRACT_FAKE", projectId: PROJECT, endpoint: ENDPOINT });
  assert.deepEqual(config, { adapter: "CONTRACT_FAKE", baseUrl: ENDPOINT }, "the page reads the api's announcement through the generated guard");
  const selection = identity.select.selectIdentityClient(config, edgeFetch);
  assert.equal(selection.kind, "CLIENT");
  assert.deepEqual([selection.client.source, selection.client.evidence], ["CONTRACT_FAKE", "SIMULATED"]);
  return selection.client;
}

const codeOf = (uid) => issuer.totpCodeFor(uid);
const wrongCode = (uid) => String((Number(codeOf(uid)) + 1) % 1_000_000).padStart(6, "0");

async function verified(step, purpose) {
  assert.equal(step.kind, "SIGNED_IN", JSON.stringify(step));
  assert.equal(step.credential.purpose, purpose);
  const outcome = await verifier.verify(step.credential.takeToken());
  assert.equal(outcome.kind, "VERIFIED", JSON.stringify(outcome));
  return outcome.token;
}

test("B11 INT-1 seam, the identity contract fake (design §6, D-W3-8, D-INT1-4): W3's web adapter, chosen from the api's same-origin announcement, signs in through W2's fake server behind the edge — password, TOTP challenge, TOTP enrolment, e-mail verification and re-authentication — and every token it hands out passes the api's own verifier", async () => {
  issuer.createAccount({ uid: "enrolled", email: "enrolled@example.test", password: "password-enrolled-1", emailVerified: true, totp: true });
  issuer.createAccount({ uid: "fresh", email: "fresh@example.test", password: "password-fresh-1", emailVerified: true, totp: false });
  issuer.createAccount({ uid: "unverified", email: "unverified@example.test", password: "password-unverified-1", emailVerified: false, totp: true });

  // an enrolled person: the password, a wrong code the flow survives, the right code
  const one = adapter();
  assert.deepEqual(await one.signIn("enrolled@example.test", "password-enrolled-1"), { kind: "TOTP_REQUIRED" });
  assert.deepEqual(await one.submitTotp(wrongCode("enrolled")), { kind: "FAILED", failure: "CODE_INVALID" });
  const enrolled = await verified(await one.submitTotp(codeOf("enrolled")), "SESSION");
  assert.deepEqual([enrolled.subject, enrolled.emailVerified, enrolled.secondFactor], ["enrolled", true, "totp"]);

  // a person without a second factor is taken to enrolment, and the first code of the new authenticator completes the sign-in
  const two = adapter();
  const enrolment = await two.signIn("fresh@example.test", "password-fresh-1");
  assert.equal(enrolment.kind, "TOTP_ENROLMENT_REQUIRED");
  const secret = /[?&]secret=([A-Z2-7]+)/.exec(enrolment.enrolment.otpauthUri)?.[1];
  assert.ok(secret, "the enrolment names its shared secret");
  const fresh = await verified(await two.enrolTotp(testing.totpCode(secret, Date.now())), "SESSION");
  assert.deepEqual([fresh.subject, fresh.secondFactor], ["fresh", "totp"]);

  // an unverified e-mail stops the sign-in until the person opens the link, then the sign-in resumes where the provider left it
  const three = adapter();
  assert.deepEqual(await three.signIn("unverified@example.test", "password-unverified-1"), { kind: "TOTP_REQUIRED" });
  assert.deepEqual(await three.submitTotp(codeOf("unverified")), { kind: "EMAIL_UNVERIFIED" });
  assert.deepEqual(await three.resendVerification(), { kind: "VERIFICATION_SENT" });
  assert.deepEqual(await three.checkVerification(), { kind: "EMAIL_UNVERIFIED" });
  const opened = await fetch(`${server.url}/__test/verify-email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "unverified@example.test" }) });
  assert.equal(opened.status, 200);
  assert.deepEqual(await three.checkVerification(), { kind: "TOTP_REQUIRED" });
  const nowVerified = await verified(await three.submitTotp(codeOf("unverified")), "SESSION");
  assert.deepEqual([nowVerified.subject, nowVerified.emailVerified], ["unverified", true]);

  // re-authentication mints a STEP_UP credential of the same person, with its second factor
  const four = adapter();
  assert.deepEqual(await four.reauthenticate("enrolled@example.test", "password-enrolled-1"), { kind: "TOTP_REQUIRED" });
  const stepUp = await verified(await four.submitTotp(codeOf("enrolled")), "STEP_UP");
  assert.deepEqual([stepUp.subject, stepUp.secondFactor], ["enrolled", "totp"]);

  // a wrong password and an unknown account answer alike, and a step out of turn sends nothing the fake would accept
  const five = adapter();
  assert.deepEqual(await five.signIn("enrolled@example.test", "not-the-password"), { kind: "FAILED", failure: "INVALID_CREDENTIALS" });
  assert.deepEqual(await five.signIn("nobody@example.test", "password-nobody-1"), { kind: "FAILED", failure: "INVALID_CREDENTIALS" });
  assert.deepEqual(await five.submitTotp(codeOf("enrolled")), { kind: "FAILED", failure: "NO_PENDING_STEP" });
});

test("B11 INT-1 seam, the fake's announcement (D-AUTH-2, D-INT1-4): the web builds the fake only for the api's same-origin endpoint — an absolute origin, a missing endpoint or the live provider never yield the fake", () => {
  const read = identity.select.readIdentityConfig;
  assert.equal(read({ adapter: "CONTRACT_FAKE", projectId: PROJECT, endpoint: "https://identity.kauro.test" }), null, "an absolute origin is not the api's announcement");
  assert.equal(read({ adapter: "CONTRACT_FAKE", projectId: PROJECT }), null, "a fake the page cannot reach is not built");
  assert.deepEqual(identity.select.selectIdentityClient(read({ adapter: "IDENTITY_PLATFORM", projectId: "kauro-live" }), edgeFetch), { kind: "LIVE_NOT_AVAILABLE" });
});

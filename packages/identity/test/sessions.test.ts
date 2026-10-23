// O23A session hijack and revocation: the served B11 SessionService, unchanged, over the offline Cognito candidate (simulator +
// verifier) and the in-memory session ports. A stolen, replaced, guessed, idle, revoked or recovered-away session never
// authenticates again; step-up refuses another person's, a stale or a single-factor re-authentication.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SESSION_POLICY, createInMemoryPorts, createSessionService, sequentialIds, sessionSecretDigest } from "@kauro/application";
import type { CorrelationId, UserId } from "@kauro/domain";
import { identityUserId } from "@kauro/domain";
import { testClock } from "@kauro/application/testing";
import { createAbuseLimiter, createCognitoTokenVerifier, createRecoveryService, judgeStepUp } from "../src/index.js";
import { InMemoryRecoveryVault, InMemoryWebSessions, SimulatedCognitoIssuer } from "../src/testing.js";

const random = (n: number) => new Uint8Array(randomBytes(n));
const cid = "0199f000-0000-7000-8000-00000000c1d0" as CorrelationId;
const ANA = "0b6f7a8e-1111-4c2d-9e3f-000000000001";
const BEN = "0b6f7a8e-1111-4c2d-9e3f-000000000002";
const EVE = "0b6f7a8e-1111-4c2d-9e3f-000000000003";

function boundary(secondFactorClaim: string | null = "custom:kauro_mfa") {
  const clock = testClock(Date.UTC(2026, 9, 22, 12));
  const issuer = new SimulatedCognitoIssuer({ clock, secondFactorClaim });
  issuer.register({ sub: ANA, email: "ana@example.test", emailVerified: true, secondFactor: "totp" });
  issuer.register({ sub: BEN, email: "ben@example.test", emailVerified: true, secondFactor: "totp" });
  issuer.register({ sub: EVE, email: "eve@example.test", emailVerified: false, secondFactor: null });
  const verifier = createCognitoTokenVerifier({ region: issuer.region, userPoolId: issuer.userPoolId, clientId: issuer.clientId, jwks: issuer.jwks(), secondFactorClaim, provider: "cognito", clock });
  const store = new InMemoryWebSessions();
  const ids = sequentialIds(clock);
  const { unitOfWork } = createInMemoryPorts(clock, ids);
  const service = createSessionService({ unitOfWork, clock, ids, random, verifier, store, fence: store });
  const signIn = async (sub: string, replacing: string | null = null) => {
    const opened = await service.open({ correlationId: cid, idToken: await issuer.idToken(sub), replacing });
    assert.equal(opened.kind, "OK", JSON.stringify(opened));
    if (opened.kind !== "OK") throw new Error("unreachable");
    return opened.value;
  };
  return { clock, issuer, store, service, signIn, userOf: (sub: string) => identityUserId("cognito", sub) as UserId };
}

test("an unverified e-mail never opens a session; a refused token is the one IDENTITY_TOKEN_INVALID", async () => {
  const { issuer, service } = boundary();
  const unverified = await service.open({ correlationId: cid, idToken: await issuer.idToken(EVE) });
  assert.equal(unverified.kind, "PROBLEM");
  if (unverified.kind === "PROBLEM") assert.equal(unverified.problem.reason, "EMAIL_NOT_VERIFIED");
  const forged = await service.open({ correlationId: cid, idToken: await issuer.accessToken(ANA) });
  assert.equal(forged.kind, "PROBLEM");
  if (forged.kind === "PROBLEM") assert.equal(forged.problem.reason, "IDENTITY_TOKEN_INVALID");
});

test("hijack: a cookie stolen before logout is dead after it; a guessed or malformed secret names nothing", async () => {
  const { service, signIn } = boundary();
  const { secret } = await signIn(ANA);
  assert.notEqual(await service.resume(secret), null);
  const stolen = secret;
  assert.deepEqual(await service.revoke({ correlationId: cid, secret }), { kind: "OK", value: null });
  assert.equal(await service.resume(stolen), null, "the revocation takes effect on the next request");
  const guess = Buffer.from(random(32)).toString("base64url");
  assert.equal(await service.resume(guess), null);
  assert.throws(() => sessionSecretDigest("not-a-secret"), RangeError, "a value this server could not have issued is refused before any lookup");
});

test("fixation: signing in with a planted cookie ends the planted session", async () => {
  const { service, signIn } = boundary();
  const planted = (await signIn(BEN)).secret;
  const { secret } = await signIn(ANA, planted);
  assert.equal(await service.resume(planted), null, "the session the browser carried is REPLACED");
  const resumed = await service.resume(secret);
  assert.notEqual(resumed, null);
  assert.notEqual(secret, planted, "the sign-in mints a new secret; it never adopts the presented one");
});

test("idle and absolute deadlines end a stolen session without any revocation", async () => {
  const { clock, service, signIn } = boundary();
  const { secret } = await signIn(ANA);
  clock.advance((SESSION_POLICY.idleSeconds + 1) * 1000);
  assert.equal(await service.resume(secret), null, "idle");
  const other = (await signIn(ANA)).secret;
  for (let elapsed = 0; elapsed < SESSION_POLICY.absoluteSeconds; elapsed += SESSION_POLICY.idleSeconds - 60) {
    assert.notEqual(await service.resume(other), null);
    clock.advance((SESSION_POLICY.idleSeconds - 60) * 1000);
  }
  assert.equal(await service.resume(other), null, "absolute, however active");
});

test("recovery ends every session of the person in every browser, and only that person's", async () => {
  const { clock, store, service, signIn, userOf } = boundary();
  const laptop = (await signIn(ANA)).secret;
  const phone = (await signIn(ANA)).secret;
  const bens = (await signIn(BEN)).secret;
  const vault = new InMemoryRecoveryVault();
  const recovery = createRecoveryService({ vault, limiter: createAbuseLimiter(clock), revoker: store, clock, random, pepper: new Uint8Array(randomBytes(32)) });
  const codes = await recovery.regenerate(userOf(ANA));
  const outcome = await recovery.redeem(userOf(ANA), codes[3] as string, null);
  assert.deepEqual(outcome, { kind: "RECOVERED", remaining: 9, sessionsEnded: 2, mfaReenrollmentRequired: true });
  assert.equal(await service.resume(laptop), null);
  assert.equal(await service.resume(phone), null);
  assert.notEqual(await service.resume(bens), null, "another person's session is untouched");
  for (const s of store.sessionsOf(userOf(ANA))) assert.equal(s.revokeReason, "RECOVERY");
});

test("sign out everywhere keeps the acting session and ends the others", async () => {
  const { store, service, signIn, userOf, clock } = boundary();
  const here = (await signIn(ANA)).secret;
  const there = (await signIn(ANA)).secret;
  const ended = await store.revokeAllOf(userOf(ANA), () => clock.now(), "SIGN_OUT_EVERYWHERE", sessionSecretDigest(here));
  assert.equal(ended, 1);
  assert.notEqual(await service.resume(here), null);
  assert.equal(await service.resume(there), null);
});

test("MFA step-up: a fresh second-factor re-authentication of the same person is a proof; others are refused", async () => {
  const { clock, issuer, service, signIn } = boundary();
  const { secret } = await signIn(ANA);
  const resumed = await service.resume(secret);
  assert.ok(resumed);
  assert.deepEqual(judgeStepUp(resumed.session, "PAYMENT_AUTHORIZE", clock.nowMs()), { kind: "STEP_UP_REQUIRED", reason: "STEP_UP_MISSING" });

  const reason = async (idToken: string) => {
    const r = await service.stepUp({ correlationId: cid, subject: resumed.subject, secret, idToken });
    return r.kind === "OK" ? "OK" : r.problem.reason;
  };
  assert.equal(await reason(await issuer.idToken(BEN)), "STEP_UP_NOT_OWNED", "another person's re-authentication");
  assert.equal(await reason(await issuer.idToken(ANA, { withSecondFactor: false })), "STEP_UP_MISSING", "a single-factor re-authentication");
  assert.equal(await reason(await issuer.idToken(ANA, { authTimeMs: clock.nowMs() - (SESSION_POLICY.stepUpReauthenticationSeconds + 1) * 1000 })), "STEP_UP_STALE");
  assert.equal(await reason(await issuer.idToken(ANA)), "OK");
  const after = await service.resume(secret);
  assert.ok(after);
  assert.equal(judgeStepUp(after.session, "PAYMENT_AUTHORIZE", clock.nowMs()).kind, "ALLOWED");
  clock.advance(15 * 60_000);
  const later = await service.resume(secret);
  assert.ok(later);
  assert.deepEqual(judgeStepUp(later.session, "PAYMENT_AUTHORIZE", clock.nowMs()), { kind: "STEP_UP_REQUIRED", reason: "STEP_UP_STALE" });
});

test("a step-up on a revoked session records nothing (the stolen cookie cannot be upgraded)", async () => {
  const { issuer, service, signIn, store, userOf } = boundary();
  const { secret } = await signIn(ANA);
  const resumed = await service.resume(secret);
  assert.ok(resumed);
  await service.revoke({ correlationId: cid, secret });
  const r = await service.stepUp({ correlationId: cid, subject: resumed.subject, secret, idToken: await issuer.idToken(ANA) });
  assert.equal(r.kind, "PROBLEM");
  assert.equal(store.proofs.filter((p) => p.userId === userOf(ANA)).length, 0);
});

test("without a decided Cognito MFA claim no step-up can be proved (fail closed until O23B)", async () => {
  const { issuer, service, signIn } = boundary(null);
  const { secret } = await signIn(ANA);
  const resumed = await service.resume(secret);
  assert.ok(resumed);
  assert.equal(resumed.session.mfaAt, null);
  const r = await service.stepUp({ correlationId: cid, subject: resumed.subject, secret, idToken: await issuer.idToken(ANA) });
  assert.equal(r.kind === "PROBLEM" ? r.problem.reason : "OK", "STEP_UP_MISSING");
});

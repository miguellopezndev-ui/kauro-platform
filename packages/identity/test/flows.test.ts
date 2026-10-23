// O23A flows with the offline simulators: abuse limits, recovery codes, e-mail verification challenges, password screening and
// the step-up policy of sensitive actions.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fixedClock } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import {
  createAbuseLimiter,
  createEmailVerification,
  createRecoveryService,
  judgePasswordPolicy,
  judgeStepUp,
  mintRecoveryCodes,
  normaliseEmail,
  normaliseRecoveryCode,
  offlineBreachCorpus,
  passwordSha1,
  screenPassword,
} from "../src/index.js";
import { CapturingOutbox, InMemoryEmailChallenges, InMemoryRecoveryVault, InMemoryWebSessions } from "../src/testing.js";

const ana = "0199f000-0000-7000-8000-000000000001" as UserId;
const ben = "0199f000-0000-7000-8000-000000000002" as UserId;
const random = (n: number) => new Uint8Array(randomBytes(n));
const pepper = new Uint8Array(randomBytes(32));
const net = "a".repeat(64);

test("abuse: an account key locks after its limit, doubles each lock-out, and a success clears only its failures", () => {
  const clock = fixedClock();
  const limiter = createAbuseLimiter(clock);
  const keys = { account: "acct-1", network: net };
  for (let i = 0; i < 4; i++) assert.equal(limiter.fail("SIGN_IN", keys).kind, "ALLOWED");
  assert.deepEqual(limiter.fail("SIGN_IN", keys), { kind: "LIMITED", retryAfterSeconds: 900 });
  assert.equal(limiter.check("SIGN_IN", { account: "acct-2", network: null }).kind, "ALLOWED", "another account is another key");
  clock.advance(900_000);
  assert.equal(limiter.check("SIGN_IN", keys).kind, "ALLOWED");
  for (let i = 0; i < 4; i++) limiter.fail("SIGN_IN", keys);
  assert.deepEqual(limiter.fail("SIGN_IN", keys), { kind: "LIMITED", retryAfterSeconds: 1_800 }, "the second lock-out doubles");
  clock.advance(1_800_000);
  limiter.fail("SIGN_IN", keys);
  limiter.succeed("SIGN_IN", keys);
  for (let i = 0; i < 4; i++) assert.equal(limiter.fail("SIGN_IN", keys).kind, "ALLOWED", "a success cleared the failures");
});

test("abuse: one network trying many accounts is limited by the network key", () => {
  const clock = fixedClock();
  const limiter = createAbuseLimiter(clock);
  for (let i = 0; i < 49; i++) assert.equal(limiter.fail("SIGN_IN", { account: `acct-${i}`, network: net }).kind, "ALLOWED");
  assert.equal(limiter.fail("SIGN_IN", { account: "acct-49", network: net }).kind, "LIMITED");
  assert.equal(limiter.check("SIGN_IN", { account: "fresh", network: net }).kind, "LIMITED", "a fresh account from the same network");
  assert.equal(limiter.check("SIGN_IN", { account: "fresh", network: "b".repeat(64) }).kind, "ALLOWED");
});

test("recovery: codes are single-use, person-bound, abuse-limited, and a redemption ends every session", async () => {
  const clock = fixedClock();
  const sessions = new InMemoryWebSessions();
  const vault = new InMemoryRecoveryVault();
  const limiter = createAbuseLimiter(clock);
  const recovery = createRecoveryService({ vault, limiter, revoker: sessions, clock, random, pepper });
  const codes = await recovery.regenerate(ana);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  const benCodes = await recovery.regenerate(ben);

  assert.deepEqual(await recovery.redeem(ana, benCodes[0] as string, net), { kind: "REFUSED" }, "another person's code");
  const first = await recovery.redeem(ana, (codes[0] as string).toLowerCase().replace("-", " "), net);
  assert.deepEqual(first, { kind: "RECOVERED", remaining: 9, sessionsEnded: 0, mfaReenrollmentRequired: true });
  assert.deepEqual(await recovery.redeem(ana, codes[0] as string, net), { kind: "REFUSED" }, "a used code");
  assert.deepEqual(await recovery.redeem(ana, "nonsense", net), { kind: "REFUSED" });
  assert.deepEqual(await recovery.redeem(ana, "ABCDE-FGHJK", net), { kind: "REFUSED" }, "the third failure since the success locks the account key");
  assert.deepEqual(await recovery.redeem(ana, codes[1] as string, net), { kind: "LIMITED", retryAfterSeconds: 3_600 }, "even a right code waits");

  const fresh = await recovery.regenerate(ana);
  clock.advance(3_600_000);
  assert.deepEqual(await recovery.redeem(ana, codes[1] as string, null), { kind: "REFUSED" }, "regeneration replaced every earlier code");
  assert.equal((await recovery.redeem(ana, fresh[0] as string, null)).kind, "RECOVERED");
});

test("recovery: normalisation maps the usual confusions and refuses anything else", () => {
  assert.equal(normaliseRecoveryCode("abcde-fghjk"), "ABCDE-FGHJK");
  assert.equal(normaliseRecoveryCode("o0iL1 23456"), "00111-23456");
  assert.equal(normaliseRecoveryCode("ABCDE-FGHJ"), null);
  assert.equal(normaliseRecoveryCode("UUUUU-UUUUU"), null);
  assert.throws(() => mintRecoveryCodes(() => new Uint8Array(9)), RangeError, "a short entropy source");
});

test("e-mail: a challenge is single-use, person-bound, superseded by the next, expires, and its sends are limited", async () => {
  const clock = fixedClock();
  const store = new InMemoryEmailChallenges();
  const outbox = new CapturingOutbox();
  const limiter = createAbuseLimiter(clock);
  const email = createEmailVerification({ store, outbox, limiter, clock, random });
  assert.deepEqual(await email.send(ana, "not-an-address", net), { kind: "INVALID_EMAIL" });
  assert.equal((await email.send(ana, " Ana@Example.TEST ", net)).kind, "SENT");
  const first = outbox.sent.at(-1);
  assert.equal(first?.to, "Ana@example.test");
  assert.deepEqual(await email.confirm(ben, first?.token as string, net), { kind: "REFUSED" }, "another person's token");
  assert.equal((await email.send(ana, "ana@example.test", net)).kind, "SENT");
  const second = outbox.sent.at(-1);
  assert.deepEqual(await email.confirm(ana, first?.token as string, net), { kind: "REFUSED" }, "superseded");
  assert.deepEqual(await email.confirm(ana, second?.token as string, net), { kind: "VERIFIED", email: "ana@example.test" });
  assert.deepEqual(await email.confirm(ana, second?.token as string, net), { kind: "REFUSED" }, "single use");
  assert.equal((await email.send(ana, "ana@example.test", net)).kind, "SENT", "three messages an hour");
  assert.equal((await email.send(ana, "ana@example.test", net)).kind, "LIMITED", "the fourth waits for the hour");
  clock.advance(3_600_000);
  assert.equal((await email.send(ana, "ana@example.test", net)).kind, "SENT");
  const third = outbox.sent.at(-1);
  clock.advance(86_400_000);
  assert.deepEqual(await email.confirm(ana, third?.token as string, net), { kind: "REFUSED" }, "expired");
  assert.equal(normaliseEmail("a@b"), null);
});

test("passwords: the policy and the k-anonymity breach screen; an unavailable corpus fails closed", async () => {
  const corpus = offlineBreachCorpus(["correct horse battery staple", "Password1234!"]);
  assert.deepEqual(judgePasswordPolicy("short"), { kind: "REFUSED", reason: "TOO_SHORT" });
  assert.deepEqual(judgePasswordPolicy("x".repeat(129)), { kind: "REFUSED", reason: "TOO_LONG" });
  assert.deepEqual(judgePasswordPolicy("tab\tseparated words"), { kind: "REFUSED", reason: "CONTROL_CHARACTER" });
  assert.deepEqual(judgePasswordPolicy("my kauro password!", {}), { kind: "REFUSED", reason: "CONTEXT_WORD" });
  assert.deepEqual(judgePasswordPolicy("anamaria-likes-tea", { email: "anamaria@example.test" }), { kind: "REFUSED", reason: "CONTEXT_WORD" });
  assert.deepEqual(await screenPassword("correct horse battery staple", corpus), { kind: "REFUSED", reason: "BREACHED" });
  assert.deepEqual(await screenPassword("a long unbreached passphrase 42", corpus), { kind: "ACCEPTED" });
  const down = { range: async () => ({ kind: "UNAVAILABLE" as const }) };
  assert.deepEqual(await screenPassword("a long unbreached passphrase 42", down), { kind: "REFUSED", reason: "UNSCREENED" });
  assert.deepEqual(await screenPassword("a long unbreached passphrase 42", down, { onUnavailable: "ACCEPT" }), { kind: "ACCEPTED" });
  // the corpus is asked for a 5-digit prefix only: the password and its full hash never leave the screen
  const asked: string[] = [];
  await screenPassword("another long passphrase 7", { range: async (p) => (asked.push(p), { kind: "RANGE", suffixes: new Set() }) });
  assert.deepEqual(asked, [passwordSha1("another long passphrase 7").slice(0, 5)]);
  await assert.rejects(corpus.range("abcde"), RangeError, "a lowercase or malformed prefix");
});

test("step-up: sensitive actions need a verified e-mail, an enrolled factor and a fresh proof", () => {
  const nowMs = Date.UTC(2026, 9, 22, 12);
  const at = (deltaS: number) => new Date(nowMs + deltaS * 1000).toISOString() as never;
  const base = { emailVerifiedAt: at(-3_600), mfaAt: at(-3_600), stepUpProofId: null, stepUpFreshUntil: null, revokedAt: null };
  assert.deepEqual(judgeStepUp({ ...base, emailVerifiedAt: null }, "PAYMENT_AUTHORIZE", nowMs), { kind: "STEP_UP_REQUIRED", reason: "EMAIL_NOT_VERIFIED" });
  assert.deepEqual(judgeStepUp({ ...base, mfaAt: null }, "PAYMENT_AUTHORIZE", nowMs), { kind: "STEP_UP_REQUIRED", reason: "MFA_NOT_ENROLLED" });
  assert.deepEqual(judgeStepUp(base, "PAYMENT_AUTHORIZE", nowMs), { kind: "STEP_UP_REQUIRED", reason: "STEP_UP_MISSING" });
  assert.deepEqual(judgeStepUp({ ...base, stepUpProofId: "p" as never, stepUpFreshUntil: at(-1) }, "PAYMENT_AUTHORIZE", nowMs), { kind: "STEP_UP_REQUIRED", reason: "STEP_UP_STALE" });
  assert.deepEqual(judgeStepUp({ ...base, stepUpProofId: "p" as never, stepUpFreshUntil: at(60) }, "PAYMENT_AUTHORIZE", nowMs), { kind: "ALLOWED", by: "STEP_UP_PROOF" });
  assert.deepEqual(judgeStepUp({ ...base, mfaAt: at(-120) }, "PAYMENT_AUTHORIZE", nowMs), { kind: "STEP_UP_REQUIRED", reason: "STEP_UP_MISSING" }, "a recent sign-in never authorizes a payment");
  assert.deepEqual(judgeStepUp({ ...base, mfaAt: at(-120) }, "DATA_EXPORT", nowMs), { kind: "ALLOWED", by: "RECENT_MFA_SIGN_IN" });
  assert.deepEqual(judgeStepUp({ ...base, mfaAt: at(-301) }, "DATA_EXPORT", nowMs), { kind: "STEP_UP_REQUIRED", reason: "STEP_UP_MISSING" });
  assert.throws(() => judgeStepUp({ ...base, revokedAt: at(-1) }, "DATA_EXPORT", nowMs));
});

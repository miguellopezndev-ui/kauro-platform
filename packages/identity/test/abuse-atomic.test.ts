// O23A review M1: the abuse limiter decides and reserves in one step, so parallel attempts cannot get past the limit; sequential use
// answers exactly as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fixedClock } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { createAbuseLimiter, createEmailVerification, createRecoveryService } from "../src/index.js";
import type { AbuseAttempt, RecoveryCodeVault } from "../src/index.js";
import { CapturingOutbox, InMemoryEmailChallenges, InMemoryRecoveryVault, InMemoryWebSessions } from "../src/testing.js";

const ana = "0199f000-0000-7000-8000-000000000001" as UserId;
const random = (n: number) => new Uint8Array(randomBytes(n));
const pepper = new Uint8Array(randomBytes(32));
const net = "a".repeat(64);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("M1: 20 parallel recovery redemptions against a limit of 3 reach the vault at most 3 times; the rest are LIMITED", async () => {
  const clock = fixedClock();
  const inner = new InMemoryRecoveryVault();
  let consumed = 0;
  // every lookup takes a turn of the event loop, so all 20 are in flight together
  const vault: RecoveryCodeVault = {
    replace: (u, d) => inner.replace(u, d),
    remaining: (u) => inner.remaining(u),
    async consume(u, d, at) {
      consumed += 1;
      await tick();
      return inner.consume(u, d, at);
    },
  };
  const recovery = createRecoveryService({ vault, limiter: createAbuseLimiter(clock), revoker: new InMemoryWebSessions(), clock, random, pepper });
  await recovery.regenerate(ana);
  const answers = await Promise.all(Array.from({ length: 20 }, () => recovery.redeem(ana, "ABCDE-FGHJK", net)));
  const refused = answers.filter((a) => a.kind === "REFUSED").length;
  const limited = answers.filter((a) => a.kind === "LIMITED").length;
  assert.equal(consumed, 3, "only the admitted attempts reached the vault");
  assert.equal(refused, 3);
  assert.equal(limited, 17);
  // the burst's three failures locked the account key for the window, as three sequential failures do
  assert.deepEqual(await recovery.redeem(ana, "ABCDE-FGHJK", net), { kind: "LIMITED", retryAfterSeconds: 3_600 });
});

test("M1: N attempts held at once admit exactly the limit, per account and per network", () => {
  const clock = fixedClock();
  const limiter = createAbuseLimiter(clock);
  const held: AbuseAttempt[] = [];
  let limitedCount = 0;
  for (let i = 0; i < 12; i++) {
    const a = limiter.attempt("SIGN_IN", { account: "acct-1", network: null });
    if (a.kind === "ADMITTED") held.push(a.attempt);
    else limitedCount += 1;
  }
  assert.equal(held.length, 5, "SIGN_IN admits 5 per account");
  assert.equal(limitedCount, 7);
  // per network: 50 accounts at once from one address, the 51st waits
  const fromNet = Array.from({ length: 51 }, (_, i) => limiter.attempt("SIGN_IN", { account: `n-${String(i)}`, network: net }));
  assert.equal(fromNet.filter((a) => a.kind === "ADMITTED").length, 50);
  assert.equal(fromNet.at(-1)?.kind, "LIMITED");
});

test("M1: a released attempt gives its place back without counting; an ended attempt ignores a second end", () => {
  const clock = fixedClock();
  const limiter = createAbuseLimiter(clock);
  const keys = { account: "acct-r", network: null };
  const taken = Array.from({ length: 3 }, () => limiter.attempt("RECOVERY_CODE", keys));
  assert.ok(taken.every((a) => a.kind === "ADMITTED"));
  assert.equal(limiter.attempt("RECOVERY_CODE", keys).kind, "LIMITED", "three in flight fill the limit");
  const first = taken[0];
  assert.ok(first?.kind === "ADMITTED");
  first.attempt.release();
  first.attempt.release();
  first.attempt.fail();
  assert.equal(limiter.attempt("RECOVERY_CODE", keys).kind, "ADMITTED", "the released place is free again and nothing was counted");
});

test("M1: sequential use answers exactly as check-then-fail did (SIGN_IN: four failures allowed, the fifth locks 900 s, then 1 800 s)", () => {
  const clock = fixedClock();
  const limiter = createAbuseLimiter(clock);
  const keys = { account: "acct-1", network: net };
  const failOnce = () => {
    const a = limiter.attempt("SIGN_IN", keys);
    assert.equal(a.kind, "ADMITTED");
    return a.kind === "ADMITTED" ? a.attempt.fail() : a;
  };
  for (let i = 0; i < 4; i++) assert.equal(failOnce().kind, "ALLOWED");
  assert.deepEqual(failOnce(), { kind: "LIMITED", retryAfterSeconds: 900 });
  assert.deepEqual(limiter.attempt("SIGN_IN", keys), { kind: "LIMITED", retryAfterSeconds: 900 });
  clock.advance(900_000);
  for (let i = 0; i < 4; i++) failOnce();
  assert.deepEqual(failOnce(), { kind: "LIMITED", retryAfterSeconds: 1_800 }, "the second lock-out doubles");
  clock.advance(1_800_000);
  failOnce();
  const ok = limiter.attempt("SIGN_IN", keys);
  assert.ok(ok.kind === "ADMITTED");
  ok.attempt.succeed();
  for (let i = 0; i < 4; i++) assert.equal(failOnce().kind, "ALLOWED", "a success cleared the failures");
});

test("M1: ten parallel e-mail sends against three an hour send three messages", async () => {
  const clock = fixedClock();
  const outbox = new CapturingOutbox();
  const email = createEmailVerification({ store: new InMemoryEmailChallenges(), outbox, limiter: createAbuseLimiter(clock), clock, random });
  const answers = await Promise.all(Array.from({ length: 10 }, () => email.send(ana, "ana@example.test", net)));
  assert.equal(answers.filter((a) => a.kind === "SENT").length, 3);
  assert.equal(outbox.sent.length, 3);
});

test("O23A2 m1: a recovery code that is not a string throws without keeping its place, so recovery is not locked for good", async () => {
  const clock = fixedClock();
  const recovery = createRecoveryService({ vault: new InMemoryRecoveryVault(), limiter: createAbuseLimiter(clock), revoker: new InMemoryWebSessions(), clock, random, pepper });
  const codes = await recovery.regenerate(ana);
  // the review's probe: three calls with a number where the contract says string, each throwing
  for (let i = 0; i < 3; i++) await assert.rejects(() => recovery.redeem(ana, 12345 as unknown as string, null));
  clock.advance(10 * 3_600_000);
  assert.deepEqual(await recovery.redeem(ana, "ABCDE-FGHJK", null), { kind: "REFUSED" }, "evaluated, not LIMITED: nothing was left held");
  assert.equal((await recovery.redeem(ana, codes[0] as string, null)).kind, "RECOVERED");
  // and without waiting at all: the throws counted nothing, so three ordinary failures still fit the limit
  const other = "0199f000-0000-7000-8000-000000000003" as UserId;
  await recovery.regenerate(other);
  for (let i = 0; i < 3; i++) await assert.rejects(() => recovery.redeem(other, 12345 as unknown as string, null));
  for (let i = 0; i < 3; i++) assert.deepEqual(await recovery.redeem(other, "ABCDE-FGHJK", null), { kind: "REFUSED" });
  assert.equal((await recovery.redeem(other, "ABCDE-FGHJK", null)).kind, "LIMITED");
});

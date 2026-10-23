// O23A browser side: the password screen sends only a 5-digit range prefix and decides locally; assurance reasons map to one next step.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { passwordPolicyCode, screenPassword, sha1Hex } from "../src/auth/password-screen.ts";
import { assuranceStepOf } from "../src/auth/step-up.ts";

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();

test("the page hashes with WebCrypto exactly as the range model does", async () => {
  assert.equal(await sha1Hex("correct horse battery staple"), sha1("correct horse battery staple"));
});

test("the screen asks for a range prefix only and refuses a breached password locally", async () => {
  const breached = sha1("correct horse battery staple");
  const asked: string[] = [];
  const ranges = async (prefix: string) => {
    asked.push(prefix);
    return prefix === breached.slice(0, 5) ? new Set([breached.slice(5)]) : new Set<string>();
  };
  assert.equal(await screenPassword("correct horse battery staple", null, ranges), "BREACHED");
  assert.equal(await screenPassword("a long unbreached passphrase 42", null, ranges), "ACCEPTED");
  assert.deepEqual(asked.map((p) => p.length), [5, 5]);
  assert.equal(await screenPassword("a long unbreached passphrase 42", null, async () => null), "UNSCREENED");
  assert.equal(await screenPassword("a long unbreached passphrase 42", null, null), "UNSCREENED", "no range source yet: fail closed");
});

test("the local policy needs no network", () => {
  assert.equal(passwordPolicyCode("short", null), "TOO_SHORT");
  assert.equal(passwordPolicyCode("x".repeat(129), null), "TOO_LONG");
  assert.equal(passwordPolicyCode("my kauro passphrase", null), "CONTEXT_WORD");
  assert.equal(passwordPolicyCode("anamaria likes tea", "anamaria@example.test"), "CONTEXT_WORD");
  assert.equal(passwordPolicyCode("line\nbreak passphrase", null), "CONTROL_CHARACTER");
});

test("each assurance reason has one next step; an unknown one is a fresh sign-in", () => {
  assert.deepEqual(assuranceStepOf("EMAIL_NOT_VERIFIED"), { kind: "VERIFY_EMAIL" });
  assert.deepEqual(assuranceStepOf("MFA_NOT_ENROLLED"), { kind: "ENROL_SECOND_FACTOR" });
  assert.deepEqual(assuranceStepOf("STEP_UP_STALE"), { kind: "REAUTHENTICATE", purpose: "STEP_UP" });
  assert.deepEqual(assuranceStepOf("STEP_UP_MISSING"), { kind: "REAUTHENTICATE", purpose: "STEP_UP" });
  assert.deepEqual(assuranceStepOf("STEP_UP_NOT_OWNED"), { kind: "SIGN_IN_AGAIN" });
  assert.deepEqual(assuranceStepOf(undefined), { kind: "SIGN_IN_AGAIN" });
});

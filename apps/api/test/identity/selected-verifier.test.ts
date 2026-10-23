// O23A: the api's provider selection binds the served verifier by default and everywhere outside LOCAL; the Cognito candidate is off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock, type IdentityTokenVerifier } from "@kauro/application";
import { offlineBreachCorpus, passwordSha1, providerSelectionOf } from "@kauro/identity";
import { SimulatedCognitoIssuer } from "@kauro/identity/testing";
import { passwordRangeReply } from "../../src/identity/password-ranges.js";
import { selectedIdentityVerifier } from "../../src/identity/selected-verifier.js";

const served: IdentityTokenVerifier = { verify: async () => ({ kind: "UNAVAILABLE" }) };

test("the default selection is the served verifier, in every environment", () => {
  const clock = fixedClock();
  for (const environment of ["LOCAL", "SANDBOX", "LIVE"] as const) {
    assert.equal(selectedIdentityVerifier(providerSelectionOf({}, environment), () => served, null, clock), served);
  }
});

test("the Cognito candidate is refused unless LOCAL with its flag on; then it verifies the simulator's tokens", async () => {
  const clock = fixedClock();
  assert.throws(() => selectedIdentityVerifier({ kind: "COGNITO", environment: "LOCAL", cognitoCandidate: false }, () => served, null, clock), /activation off/);
  assert.throws(() => selectedIdentityVerifier({ kind: "COGNITO", environment: "LIVE", cognitoCandidate: true }, () => served, null, clock), /LOCAL only/);
  const selection = providerSelectionOf({ KAURO_IDENTITY_PROVIDER: "COGNITO", KAURO_IDENTITY_COGNITO_CANDIDATE: "on" }, "LOCAL");
  assert.throws(() => selectedIdentityVerifier(selection, () => served, null, clock), /offline pool/);
  const issuer = new SimulatedCognitoIssuer({ clock });
  issuer.register({ sub: "0b6f7a8e-1111-4c2d-9e3f-000000000001", email: "ana@example.test", emailVerified: true, secondFactor: null });
  const verifier = selectedIdentityVerifier(selection, () => served, { region: issuer.region, userPoolId: issuer.userPoolId, clientId: issuer.clientId, jwks: issuer.jwks(), secondFactorClaim: null }, clock);
  const v = await verifier.verify(await issuer.idToken("0b6f7a8e-1111-4c2d-9e3f-000000000001"));
  assert.equal(v.kind === "VERIFIED" ? v.token.provider : v.kind, "cognito");
});

test("the password range answer: suffixes only, sorted; a malformed prefix is 400; an unavailable corpus is a retryable 503", async () => {
  const corpus = offlineBreachCorpus(["correct horse battery staple"]);
  const sha1 = passwordSha1("correct horse battery staple");
  assert.deepEqual(await passwordRangeReply(sha1.slice(0, 5), corpus), { status: 200, body: sha1.slice(5), cacheControl: "public, max-age=86400" });
  assert.deepEqual(await passwordRangeReply("00000", corpus), { status: 200, body: "", cacheControl: "public, max-age=86400" });
  assert.deepEqual(await passwordRangeReply("abcde", corpus), { status: 400 });
  assert.deepEqual(await passwordRangeReply("ABCDEF", corpus), { status: 400 });
  assert.deepEqual(await passwordRangeReply("ABCDE", { range: async () => ({ kind: "UNAVAILABLE" }) }), { status: 503, retryAfterSeconds: 5 });
});

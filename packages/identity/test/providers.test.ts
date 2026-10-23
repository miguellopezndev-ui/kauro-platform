// O23A pluggable providers: the offline Cognito verifier against the simulator (every defect named, the same facts as the served
// verifier) and the activation guard (the served provider stays the default; the Cognito candidate is off and LOCAL-only).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { SignJWT } from "jose";
import { fixedClock } from "@kauro/application";
import { IDENTITY_PROVIDERS, assertProviderSelection, createCognitoTokenVerifier, providerSelectionOf } from "../src/index.js";
import { SimulatedCognitoIssuer } from "../src/testing.js";

function setup(secondFactorClaim: string | null = "custom:kauro_mfa") {
  const clock = fixedClock();
  const issuer = new SimulatedCognitoIssuer({ clock, secondFactorClaim });
  issuer.register({ sub: "0b6f7a8e-1111-4c2d-9e3f-000000000001", email: "ana@example.test", emailVerified: true, secondFactor: "totp" });
  const verifier = createCognitoTokenVerifier({ region: issuer.region, userPoolId: issuer.userPoolId, clientId: issuer.clientId, jwks: issuer.jwks(), secondFactorClaim, provider: IDENTITY_PROVIDERS.COGNITO.provider, clock });
  return { clock, issuer, verifier, sub: "0b6f7a8e-1111-4c2d-9e3f-000000000001" };
}

test("a Cognito ID token of the simulator verifies to the same facts the served verifier produces", async () => {
  const { issuer, verifier, sub, clock } = setup();
  const v = await verifier.verify(await issuer.idToken(sub));
  assert.equal(v.kind, "VERIFIED");
  if (v.kind !== "VERIFIED") return;
  assert.deepEqual(v.token, {
    provider: "cognito",
    subject: sub,
    emailVerified: true,
    secondFactor: "totp",
    authTime: clock.now(),
    issuedAt: clock.now(),
    expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString(),
  });
});

test("every defect of a Cognito token is refused with its name", async () => {
  const { issuer, verifier, sub, clock } = setup();
  const defect = async (token: string) => {
    const v = await verifier.verify(token);
    return v.kind === "REJECTED" ? v.defect : v.kind;
  };
  assert.equal(await defect("not-a-jwt"), "MALFORMED");
  assert.equal(await defect(await issuer.accessToken(sub)), "CLAIM", "an access token has no aud: never a sign-in proof");
  assert.equal(await defect(await issuer.idToken(sub, { overrides: { token_use: "access" } })), "CLAIM", "token_use must be id");
  assert.equal(await defect(await issuer.idToken(sub, { overrides: { iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" } })), "ISSUER");
  assert.equal(await defect(await issuer.idToken(sub, { overrides: { aud: "anotherclient" } })), "AUDIENCE");
  assert.equal(await defect(await issuer.idToken(sub, { overrides: { email_verified: "true" } })), "CLAIM", "a string email_verified is not the documented boolean");
  assert.equal(await defect(await issuer.idToken(sub, { overrides: { "custom:kauro_mfa": 1 } })), "CLAIM");
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.equal(await defect(await issuer.idToken(sub, { signWith: other })), "SIGNATURE");
  const hs = await new SignJWT({ sub, token_use: "id" }).setProtectedHeader({ alg: "HS256", kid: issuer.kid }).sign(new Uint8Array(32));
  assert.equal(await defect(hs), "ALGORITHM");
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", kid: issuer.kid })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.`;
  assert.equal(await defect(unsigned), "ALGORITHM");
  const foreignKid = await new SignJWT({ sub }).setProtectedHeader({ alg: "RS256", kid: "unknown" }).sign(other);
  assert.equal(await defect(foreignKid), "UNKNOWN_KEY");
  assert.equal(await defect(await issuer.idToken(sub, { authTimeMs: clock.nowMs() + 120_000 })), "AUTH_TIME", "an auth_time in the future");
  const old = await issuer.idToken(sub, { lifetimeSeconds: 60 });
  clock.advance(61_000);
  assert.equal(await defect(old), "EXPIRED");
});

test("without a decided second-factor claim every Cognito token is single-factor (fail closed until O23B)", async () => {
  const { issuer, verifier, sub } = setup(null);
  const v = await verifier.verify(await issuer.idToken(sub, { overrides: { "custom:kauro_mfa": "totp", amr: ["mfa"] } }));
  assert.equal(v.kind, "VERIFIED");
  if (v.kind === "VERIFIED") assert.equal(v.token.secondFactor, null);
});

test("the served provider is the default; the Cognito candidate is off and LOCAL-only; the simulator is LOCAL-only", () => {
  assert.deepEqual(providerSelectionOf({}, "LIVE"), { kind: "IDENTITY_PLATFORM", environment: "LIVE", cognitoCandidate: false });
  assert.equal(IDENTITY_PROVIDERS.COGNITO.activation, "CANDIDATE_OFF");
  assert.throws(() => providerSelectionOf({ KAURO_IDENTITY_PROVIDER: "COGNITO" }, "LOCAL"), /activation off/);
  assert.throws(() => providerSelectionOf({ KAURO_IDENTITY_PROVIDER: "COGNITO", KAURO_IDENTITY_COGNITO_CANDIDATE: "on" }, "SANDBOX"), /LOCAL only/);
  assert.throws(() => providerSelectionOf({ KAURO_IDENTITY_PROVIDER: "COGNITO", KAURO_IDENTITY_COGNITO_CANDIDATE: "on" }, "LIVE"), /LOCAL only/);
  assert.equal(providerSelectionOf({ KAURO_IDENTITY_PROVIDER: "COGNITO", KAURO_IDENTITY_COGNITO_CANDIDATE: "on" }, "LOCAL").kind, "COGNITO");
  assert.throws(() => providerSelectionOf({ KAURO_IDENTITY_PROVIDER: "SIMULATOR" }, "LIVE"), /LOCAL only/);
  assert.throws(() => providerSelectionOf({ KAURO_IDENTITY_PROVIDER: "cognito" }, "LOCAL"), /KAURO_IDENTITY_PROVIDER/);
  assert.throws(() => providerSelectionOf({ KAURO_IDENTITY_COGNITO_CANDIDATE: "yes" }, "LOCAL"), /on or off/);
  assert.doesNotThrow(() => assertProviderSelection({ kind: "IDENTITY_PLATFORM", environment: "LIVE", cognitoCandidate: true }));
});

test("the verifier refuses to be built over a malformed pool, client or key set", () => {
  const clock = fixedClock();
  const issuer = new SimulatedCognitoIssuer({ clock });
  const base = { region: issuer.region, userPoolId: issuer.userPoolId, clientId: issuer.clientId, jwks: issuer.jwks(), secondFactorClaim: null, provider: "cognito", clock };
  assert.throws(() => createCognitoTokenVerifier({ ...base, region: "nowhere" }), RangeError);
  assert.throws(() => createCognitoTokenVerifier({ ...base, userPoolId: "eu-west-1_Pool" }), RangeError, "a pool of another region");
  assert.throws(() => createCognitoTokenVerifier({ ...base, clientId: "Bad Client" }), RangeError);
  const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" });
  assert.throws(() => createCognitoTokenVerifier({ ...base, jwks: { keys: [{ ...small, kid: "k" }] } }), TypeError);
  assert.throws(() => createCognitoTokenVerifier({ ...base, jwks: { keys: [{ ...small }] } }), TypeError);
});

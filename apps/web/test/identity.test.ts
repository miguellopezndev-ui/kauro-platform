// The IdentityClient port and its CONTRACT_FAKE adapter (design D-AUTH-2, section 6). The oracle is the design's own sentences: the fake
// says what it is, a provider token has exactly one use and is not a member anybody can read, every reply that is not the pinned protocol
// is a protocol error and never a guess, and the live adapter is never silently replaced by the fake. The network is a script: an answer
// arrives when the test lets it, and a call is awaited, never slept on.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import type { FetchedResponse, FetchInit } from "../src/client/api-client.ts";
import { ApiClient } from "../src/client/api-client.ts";
import { ContractFakeIdentityClient, fetchIdentityTransport, IDENTITY_FAKE_PROTOCOL, type IdentityTransport, type IdentityTransportResponse } from "../src/client/identity/contract-fake.ts";
import { IdentityCredential, type IdentityConfig, type IdentityStep } from "../src/client/identity/port.ts";
import { readIdentityConfig, selectIdentityClient } from "../src/client/identity/select.ts";
import { createSession } from "../src/client/session-api.ts";

const EMAIL = "owner@agency.example";
const PASSWORD = "correct horse battery staple";
const ID_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
const OTHER_ID_TOKEN = "aGVhZGVy.b3RoZXI.c2lnbmF0dXJl";
const PENDING = "pending-0123456789abcdef";
const OTPAUTH = "otpauth://totp/Kauro:owner%40agency.example?secret=JBSWY3DPEHPK3PXP&issuer=Kauro";
const CSRF = "csrf_token_one_0123456789abcdef0123456789ab";

const ok = (body: unknown): IdentityTransportResponse => ({ status: 200, body });
const denied = (error: string, status = 401): IdentityTransportResponse => ({ status, body: { error } });
const signedIn = (idToken = ID_TOKEN): IdentityTransportResponse => ok({ outcome: "SIGNED_IN", idToken });
const totpRequired = (): IdentityTransportResponse => ok({ outcome: "TOTP_REQUIRED", pendingToken: PENDING });
const enrolmentRequired = (): IdentityTransportResponse => ok({ outcome: "TOTP_ENROLMENT_REQUIRED", pendingToken: PENDING, otpauthUri: OTPAUTH });
const unverified = (): IdentityTransportResponse => ok({ outcome: "EMAIL_UNVERIFIED", pendingToken: PENDING });
const sent = (): IdentityTransportResponse => ok({ outcome: "SENT" });

interface Call {
  readonly route: string;
  readonly body: Readonly<Record<string, string>>;
}

/** A transport that answers from a queue, in order, and records what it was asked. A call with an empty queue is a bug of the test. */
function scripted(...answers: Array<IdentityTransportResponse | null>) {
  const calls: Call[] = [];
  const queue = [...answers];
  const transport: IdentityTransport = async (route, body) => {
    calls.push({ route, body });
    if (queue.length === 0) throw new Error(`unscripted call to ${route}`);
    return queue.shift() ?? null;
  };
  return { transport, calls };
}

interface Held {
  readonly transport: IdentityTransport;
  readonly calls: Call[];
  /** Lets the one call that is out complete with this answer. */
  release(answer: IdentityTransportResponse | null): void;
}

/** A transport whose answer is held until the test releases it, so a second activation can be made while the first is out. */
function held(): Held {
  const calls: Call[] = [];
  const waiting: Array<(answer: IdentityTransportResponse | null) => void> = [];
  const transport: IdentityTransport = (route, body) => {
    calls.push({ route, body });
    return new Promise((resolve) => waiting.push(resolve));
  };
  return {
    transport,
    calls,
    release: (answer) => {
      const next = waiting.shift();
      assert.ok(next, "a call is out");
      next(answer);
    },
  };
}

function never(): never {
  throw new Error("this fetch is never called");
}

function only<K extends IdentityStep["kind"]>(step: IdentityStep, kind: K): Extract<IdentityStep, { kind: K }> {
  assert.equal(step.kind, kind, JSON.stringify(step));
  return step as Extract<IdentityStep, { kind: K }>;
}

test("D-AUTH-2: the contract fake says what it is (CONTRACT_FAKE, SIMULATED), and so does every credential it hands out", async () => {
  const { transport } = scripted(signedIn());
  const client = new ContractFakeIdentityClient(transport);
  assert.equal(client.source, "CONTRACT_FAKE");
  assert.equal(client.evidence, "SIMULATED");
  assert.equal(IDENTITY_FAKE_PROTOCOL.version, "kauro-fake-identity-v1");
  const { credential } = only(await client.signIn(EMAIL, PASSWORD), "SIGNED_IN");
  assert.equal(credential.source, "CONTRACT_FAKE");
  assert.equal(credential.purpose, "SESSION");
});

test("D-AUTH-2, D-PRIV-1: a credential's token has one use, is not a member of the object, and is in no serialisation, inspection or step description of it", async () => {
  const { transport } = scripted(signedIn());
  const step = await new ContractFakeIdentityClient(transport).signIn(EMAIL, PASSWORD);
  const { credential } = only(step, "SIGNED_IN");
  assert.deepEqual(Object.getOwnPropertyNames(credential).sort(), ["purpose", "source"], "no own member holds the token");
  assert.equal(Object.getOwnPropertySymbols(credential).length, 0);
  for (const shown of [JSON.stringify(step), JSON.stringify(credential), inspect(step, { depth: 8, showHidden: true }), String(credential), `${JSON.stringify(Object.entries(credential))}`]) {
    assert.equal(shown.includes(ID_TOKEN), false, "the token is not in a printed form of the credential");
    assert.equal(shown.includes("cGF5bG9hZA"), false, "no part of the token is either");
  }
  assert.deepEqual(credential.toJSON(), { source: "CONTRACT_FAKE", purpose: "SESSION", spent: false });
  assert.equal(credential.spent, false);
  assert.equal(credential.takeToken(), ID_TOKEN);
  assert.equal(credential.spent, true);
  assert.throws(() => credential.takeToken(), /already taken/, "a second use is a bug");
  assert.deepEqual(credential.toJSON(), { source: "CONTRACT_FAKE", purpose: "SESSION", spent: true });
  assert.throws(() => new IdentityCredential("CONTRACT_FAKE", "SESSION", ""), RangeError, "a credential without a token is not a credential");
});

test("D-AUTH-2: sign-in without a second factor completes on the first answer, and asks the fake for nothing else", async () => {
  const { transport, calls } = scripted(signedIn());
  const client = new ContractFakeIdentityClient(transport);
  only(await client.signIn(EMAIL, PASSWORD), "SIGNED_IN");
  assert.deepEqual(calls, [{ route: "/v1/sign-in", body: { email: EMAIL, password: PASSWORD } }]);
  only(await client.submitTotp("123456"), "FAILED");
  assert.equal(calls.length, 1, "after a completed sign-in nothing is pending, so nothing is asked");
});

test("D-AUTH-2: a TOTP challenge carries the pending handle, a wrong code keeps the flow, and the right one completes it", async () => {
  const { transport, calls } = scripted(totpRequired(), denied("CODE_INVALID", 400), signedIn());
  const client = new ContractFakeIdentityClient(transport);
  only(await client.signIn(EMAIL, PASSWORD), "TOTP_REQUIRED");
  assert.deepEqual(only(await client.submitTotp("000000"), "FAILED").failure, "CODE_INVALID");
  const done = only(await client.submitTotp("123456"), "SIGNED_IN");
  assert.equal(done.credential.takeToken(), ID_TOKEN);
  assert.deepEqual(calls.map((call) => [call.route, call.body]), [
    ["/v1/sign-in", { email: EMAIL, password: PASSWORD }],
    ["/v1/totp/verify", { pendingToken: PENDING, code: "000000" }],
    ["/v1/totp/verify", { pendingToken: PENDING, code: "123456" }],
  ]);
  only(await client.submitTotp("123456"), "FAILED");
  assert.equal(calls.length, 3, "the finished flow forgot its handle");
});

test("D-AUTH-2: a code that is not six digits is refused on the page, before any request, and does not end the flow", async () => {
  const { transport, calls } = scripted(totpRequired(), signedIn());
  const client = new ContractFakeIdentityClient(transport);
  only(await client.signIn(EMAIL, PASSWORD), "TOTP_REQUIRED");
  for (const code of ["", "12345", "1234567", "12345a", " 123456", "123456 ", "١٢٣٤٥٦", "12\n3456"]) {
    assert.equal(only(await client.submitTotp(code), "FAILED").failure, "CODE_INVALID", JSON.stringify(code));
  }
  assert.equal(calls.length, 1, "none of them was sent");
  only(await client.submitTotp("123456"), "SIGNED_IN");
});

test("D-AUTH-2: a person without an authenticator is offered enrolment once, and the first code completes it", async () => {
  const { transport, calls } = scripted(enrolmentRequired(), signedIn());
  const client = new ContractFakeIdentityClient(transport);
  const step = only(await client.signIn(EMAIL, PASSWORD), "TOTP_ENROLMENT_REQUIRED");
  assert.equal(step.enrolment.otpauthUri, OTPAUTH);
  only(await client.enrolTotp("654321"), "SIGNED_IN");
  assert.deepEqual(calls[1], { route: "/v1/totp/enrol", body: { pendingToken: PENDING, code: "654321" } });
});

test("D-AUTH-2: an unverified e-mail can be sent again and checked again, and the check that finds it verified completes the sign-in", async () => {
  const { transport, calls } = scripted(unverified(), sent(), unverified(), signedIn());
  const client = new ContractFakeIdentityClient(transport);
  only(await client.signIn(EMAIL, PASSWORD), "EMAIL_UNVERIFIED");
  only(await client.resendVerification(), "VERIFICATION_SENT");
  only(await client.checkVerification(), "EMAIL_UNVERIFIED");
  only(await client.checkVerification(), "SIGNED_IN");
  assert.deepEqual(calls.map((call) => [call.route, call.body]), [
    ["/v1/sign-in", { email: EMAIL, password: PASSWORD }],
    ["/v1/email/verification/send", { pendingToken: PENDING }],
    ["/v1/email/verification/status", { pendingToken: PENDING }],
    ["/v1/email/verification/status", { pendingToken: PENDING }],
  ]);
});

test("D-AUTH-2, D-AUTH-4: re-authentication mints a STEP_UP credential, and the next sign-in is a SESSION credential again", async () => {
  const { transport, calls } = scripted(totpRequired(), signedIn(), signedIn(OTHER_ID_TOKEN));
  const client = new ContractFakeIdentityClient(transport);
  only(await client.reauthenticate(EMAIL, PASSWORD), "TOTP_REQUIRED");
  const proof = only(await client.submitTotp("123456"), "SIGNED_IN");
  assert.equal(proof.credential.purpose, "STEP_UP");
  assert.equal(calls[0]?.route, "/v1/reauthenticate");
  const next = only(await client.signIn(EMAIL, PASSWORD), "SIGNED_IN");
  assert.equal(next.credential.purpose, "SESSION");
  assert.equal(next.credential.takeToken(), OTHER_ID_TOKEN);
});

test("D-AUTH-2: a sign-in that starts over forgets the one in progress, and cancel forgets it too", async () => {
  const { transport, calls } = scripted(totpRequired(), unverified());
  const client = new ContractFakeIdentityClient(transport);
  only(await client.signIn(EMAIL, PASSWORD), "TOTP_REQUIRED");
  only(await client.signIn(EMAIL, PASSWORD), "EMAIL_UNVERIFIED");
  only(await client.submitTotp("123456"), "FAILED");
  assert.equal(calls.length, 2, "the first challenge was replaced, so a code has nothing to answer");
  client.cancel();
  assert.equal(only(await client.checkVerification(), "FAILED").failure, "NO_PENDING_STEP");
  assert.equal(calls.length, 2);
});

test("D-AUTH-2: a step answers only the step it was offered: a code for an e-mail check, or an e-mail check for a challenge, is NO_PENDING_STEP and sends nothing", async () => {
  const challenge = scripted(totpRequired());
  const client = new ContractFakeIdentityClient(challenge.transport);
  only(await client.signIn(EMAIL, PASSWORD), "TOTP_REQUIRED");
  for (const run of [() => client.enrolTotp("123456"), () => client.resendVerification(), () => client.checkVerification()]) {
    assert.equal(only(await run(), "FAILED").failure, "NO_PENDING_STEP");
  }
  const enrolment = scripted(enrolmentRequired());
  const enrolling = new ContractFakeIdentityClient(enrolment.transport);
  only(await enrolling.signIn(EMAIL, PASSWORD), "TOTP_ENROLMENT_REQUIRED");
  assert.equal(only(await enrolling.submitTotp("123456"), "FAILED").failure, "NO_PENDING_STEP");
  const email = scripted(unverified(), totpRequired(), signedIn());
  const waiting = new ContractFakeIdentityClient(email.transport);
  only(await waiting.signIn(EMAIL, PASSWORD), "EMAIL_UNVERIFIED");
  assert.equal(only(await waiting.submitTotp("123456"), "FAILED").failure, "NO_PENDING_STEP");
  assert.equal(only(await waiting.enrolTotp("123456"), "FAILED").failure, "NO_PENDING_STEP");
  assert.deepEqual([challenge.calls.length, enrolment.calls.length, email.calls.length], [1, 1, 1]);
  // a verified e-mail can lead to a challenge, and the challenge is then the step that is open
  only(await waiting.checkVerification(), "TOTP_REQUIRED");
  only(await waiting.submitTotp("123456"), "SIGNED_IN");
});

test("D-AUTH-2: every step that needs a sign-in in progress says NO_PENDING_STEP without sending anything when there is none", async () => {
  const { transport, calls } = scripted();
  const client = new ContractFakeIdentityClient(transport);
  for (const run of [() => client.submitTotp("123456"), () => client.enrolTotp("123456"), () => client.resendVerification(), () => client.checkVerification()]) {
    assert.equal(only(await run(), "FAILED").failure, "NO_PENDING_STEP");
  }
  assert.deepEqual(calls, []);
});

test("D-AUTH-2: a second activation of a step that is still out joins it, so one request produces one answer for both", async () => {
  const world = held();
  const client = new ContractFakeIdentityClient(world.transport);
  const first = client.signIn(EMAIL, PASSWORD);
  const second = client.signIn(EMAIL, PASSWORD);
  assert.equal(world.calls.length, 1, "one request for two activations");
  world.release(signedIn());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, "the same answer object");
  const { credential } = only(a, "SIGNED_IN");
  assert.equal(credential.takeToken(), ID_TOKEN, "one credential, so one token to use");

  // the step is free again once it has answered: a new activation is a new request
  const again = scripted(totpRequired(), signedIn());
  const client2 = new ContractFakeIdentityClient(again.transport);
  only(await client2.signIn(EMAIL, PASSWORD), "TOTP_REQUIRED");
  const code = client2.submitTotp("123456");
  const repeat = client2.submitTotp("123456");
  only(await code, "SIGNED_IN");
  assert.equal(await repeat, await code);
  assert.equal(again.calls.length, 2);
});

test("D-AUTH-2: failures that no retry can fix end the flow, and only a wrong code or a lost connection may be tried again", async () => {
  for (const [reply, keeps] of [
    [denied("INVALID_CREDENTIALS"), false],
    [denied("TOO_MANY_ATTEMPTS", 429), false],
    [denied("NO_PENDING_STEP", 409), false],
    [denied("CODE_INVALID", 400), true],
    [{ status: 503, body: undefined }, true],
    [null, true],
    [{ status: 200, body: { outcome: "SENT" } }, false],
    [{ status: 200, body: "not an object" }, false],
  ] as const) {
    const { transport, calls } = scripted(totpRequired(), reply);
    const client = new ContractFakeIdentityClient(transport);
    only(await client.signIn(EMAIL, PASSWORD), "TOTP_REQUIRED");
    only(await client.submitTotp("123456"), "FAILED");
    const before = calls.length;
    const again = await client.submitTotp("123456").catch(() => null);
    if (keeps) assert.equal(calls.length, before + 1, `${JSON.stringify(reply)} keeps the flow`);
    else {
      assert.equal(calls.length, before, `${JSON.stringify(reply)} ends the flow`);
      assert.equal(again === null ? "thrown" : only(again, "FAILED").failure, "NO_PENDING_STEP");
    }
  }
});

test("D-AUTH-2: a reply that is not the pinned protocol is a PROTOCOL_ERROR, and only a missing or server-side answer is UNAVAILABLE", async () => {
  const table: Array<[string, IdentityTransportResponse | null, string]> = [
    ["no readable answer", null, "UNAVAILABLE"],
    ["a 500", { status: 500, body: { outcome: "SIGNED_IN", idToken: ID_TOKEN } }, "UNAVAILABLE"],
    ["a 503 with a garbled body", { status: 503, body: undefined }, "UNAVAILABLE"],
    ["status zero", { status: 0, body: undefined }, "UNAVAILABLE"],
    ["a 200 with no body", { status: 200, body: undefined }, "PROTOCOL_ERROR"],
    ["a 200 with an array", { status: 200, body: [] }, "PROTOCOL_ERROR"],
    ["a 200 with null", { status: 200, body: null }, "PROTOCOL_ERROR"],
    ["a 201", { status: 201, body: { outcome: "SIGNED_IN", idToken: ID_TOKEN } }, "PROTOCOL_ERROR"],
    ["a redirect", { status: 302, body: {} }, "PROTOCOL_ERROR"],
    ["an outcome nobody defined", ok({ outcome: "WELCOME_BACK", idToken: ID_TOKEN }), "PROTOCOL_ERROR"],
    ["an inherited outcome name", ok({ outcome: "constructor" }), "PROTOCOL_ERROR"],
    ["a prototype outcome name", ok({ outcome: "__proto__" }), "PROTOCOL_ERROR"],
    ["no outcome", ok({ idToken: ID_TOKEN }), "PROTOCOL_ERROR"],
    ["an outcome that is not text", ok({ outcome: 1, idToken: ID_TOKEN }), "PROTOCOL_ERROR"],
    ["an extra member", ok({ outcome: "SIGNED_IN", idToken: ID_TOKEN, role: "OWNER" }), "PROTOCOL_ERROR"],
    ["a missing member", ok({ outcome: "TOTP_ENROLMENT_REQUIRED", pendingToken: PENDING }), "PROTOCOL_ERROR"],
    ["a member of another outcome", ok({ outcome: "SIGNED_IN", pendingToken: PENDING }), "PROTOCOL_ERROR"],
    ["an id token of two parts", ok({ outcome: "SIGNED_IN", idToken: "aGVhZGVy.cGF5bG9hZA" }), "PROTOCOL_ERROR"],
    ["an id token with a space", ok({ outcome: "SIGNED_IN", idToken: "aGVh ZGVy.cGF5bG9hZA.c2ln" }), "PROTOCOL_ERROR"],
    ["an id token that is not text", ok({ outcome: "SIGNED_IN", idToken: 7 }), "PROTOCOL_ERROR"],
    ["an empty id token", ok({ outcome: "SIGNED_IN", idToken: "" }), "PROTOCOL_ERROR"],
    ["an authenticator address of another scheme", ok({ outcome: "TOTP_ENROLMENT_REQUIRED", pendingToken: PENDING, otpauthUri: "https://example.test/totp/x" }), "PROTOCOL_ERROR"],
    ["a 401 with a code nobody defined", denied("LOCKED_OUT"), "PROTOCOL_ERROR"],
    ["a 401 with an extra member", { status: 401, body: { error: "INVALID_CREDENTIALS", detail: "x" } }, "PROTOCOL_ERROR"],
    ["a 401 whose error is not text", { status: 401, body: { error: 401 } }, "PROTOCOL_ERROR"],
    ["a 401 with a prototype name", denied("toString"), "PROTOCOL_ERROR"],
    ["a 401 with no body", { status: 401, body: undefined }, "PROTOCOL_ERROR"],
    ["a plain answer where a sign-in step was expected", sent(), "PROTOCOL_ERROR"],
  ];
  for (const [label, answer, expected] of table) {
    const { transport } = scripted(answer);
    const step = await new ContractFakeIdentityClient(transport).signIn(EMAIL, PASSWORD);
    assert.equal(only(step, "FAILED").failure, expected, label);
  }
  // the prototype of a reply is part of its shape
  const inherited = Object.create({ outcome: "SIGNED_IN", idToken: ID_TOKEN }) as unknown;
  const { transport } = scripted({ status: 200, body: inherited });
  assert.equal(only(await new ContractFakeIdentityClient(transport).signIn(EMAIL, PASSWORD), "FAILED").failure, "PROTOCOL_ERROR");
});

test("D-AUTH-2: the closed error names of the protocol map to themselves and to nothing else", async () => {
  for (const name of IDENTITY_FAKE_PROTOCOL.errors) {
    const { transport } = scripted(denied(name, 400));
    assert.equal(only(await new ContractFakeIdentityClient(transport).signIn(EMAIL, PASSWORD), "FAILED").failure, name);
  }
});

test("D-AUTH-2: credentials that could not be an e-mail and a password are refused on the page, and no request carries them", async () => {
  const { transport, calls } = scripted();
  const client = new ContractFakeIdentityClient(transport);
  for (const [email, password] of [
    ["", PASSWORD],
    ["no-at-sign", PASSWORD],
    ["a b@agency.example", PASSWORD],
    ["owner@", PASSWORD],
    ["@agency.example", PASSWORD],
    [`${"a".repeat(65)}@agency.example`, PASSWORD],
    [EMAIL, ""],
    [EMAIL, "x".repeat(1025)],
  ] as const) {
    assert.equal(only(await client.signIn(email, password), "FAILED").failure, "INVALID_CREDENTIALS", `${email} / ${password.length}`);
    assert.equal(only(await client.reauthenticate(email, password), "FAILED").failure, "INVALID_CREDENTIALS");
  }
  assert.deepEqual(calls, []);
});

test("D-AUTH-2: the transport of a page is a same-origin path, never cached, never redirected, and its failures are absences, not exceptions", async () => {
  for (const good of ["/fake-identity", "/api/fake-identity", "/a.b/c_d/e~f"]) assert.doesNotThrow(() => fetchIdentityTransport(async () => never(), good), good);
  for (const bad of ["", "fake-identity", "/", "//evil.example", "https://evil.example/x", "http://localhost/x", "/a/", "/a//b", "/a/../b", "/../a", "/./a", "/a b", "/a?x=1", "/a#x", "/a\\b", "/ａ", "/a\n"]) {
    assert.throws(() => fetchIdentityTransport(async () => never(), bad), RangeError, JSON.stringify(bad));
  }

  const seen: Array<{ url: string; init: FetchInit }> = [];
  const respond = (status: number, text: () => Promise<string>): FetchedResponse => ({ status, headers: { get: () => null }, text });
  const script: Array<() => Promise<FetchedResponse>> = [
    async () => respond(200, async () => JSON.stringify({ outcome: "SENT" })),
    async () => respond(502, async () => "<html>bad gateway</html>"),
    async () => respond(200, async () => {
      throw new TypeError("body lost");
    }),
    async () => {
      throw new TypeError("network down");
    },
  ];
  const transport = fetchIdentityTransport(async (url, init) => {
    seen.push({ url, init });
    const next = script.shift();
    assert.ok(next, "a scripted answer");
    return next();
  }, "/fake-identity");

  assert.deepEqual(await transport("/v1/sign-in", { email: EMAIL, password: PASSWORD }), { status: 200, body: { outcome: "SENT" } });
  const [first] = seen;
  assert.ok(first);
  assert.equal(first.url, "/fake-identity/v1/sign-in");
  assert.deepEqual(first.init, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
    mode: "same-origin",
  });
  assert.deepEqual(await transport("/v1/sign-in", { email: EMAIL, password: PASSWORD }), { status: 502, body: undefined }, "a body that is not JSON is a status without a body");
  assert.deepEqual(await transport("/v1/sign-in", { email: EMAIL, password: PASSWORD }), { status: 200, body: undefined }, "an unreadable body is a status without a body");
  assert.equal(await transport("/v1/sign-in", { email: EMAIL, password: PASSWORD }), null, "a lost connection is no answer");
});

test("D-AUTH-2: the announcement selects the fake only when it names the fake with a same-origin path, and the live adapter is never replaced by the fake", () => {
  const unusedFetch = async (): Promise<FetchedResponse> => never();
  const chosen = selectIdentityClient({ adapter: "CONTRACT_FAKE", baseUrl: "/fake-identity" }, unusedFetch);
  assert.equal(chosen.kind, "CLIENT");
  if (chosen.kind === "CLIENT") {
    assert.equal(chosen.client.source, "CONTRACT_FAKE");
    assert.equal(chosen.client.evidence, "SIMULATED");
  }
  assert.deepEqual(selectIdentityClient({ adapter: "LIVE" }, unusedFetch), { kind: "LIVE_NOT_AVAILABLE" }, "no silent fallback to the fake");
  for (const baseUrl of ["https://evil.example/fake", "//evil.example", "..", "/a/../b"]) {
    assert.deepEqual(selectIdentityClient({ adapter: "CONTRACT_FAKE", baseUrl }, unusedFetch), { kind: "CONFIG_REFUSED" }, baseUrl);
  }
});

test("D-AUTH-2: an announcement of unknown shape is read as one of the two configurations or as nothing", () => {
  // the api's announcement is getIdentityConfig's reply (W2): {adapter, projectId[, endpoint]}, read through its generated guard
  const cases: Array<[unknown, IdentityConfig | null]> = [
    [{ adapter: "IDENTITY_PLATFORM", projectId: "kauro-live" }, { adapter: "LIVE" }],
    [{ adapter: "CONTRACT_FAKE", projectId: "kauro-local", endpoint: "/fake-identity" }, { adapter: "CONTRACT_FAKE", baseUrl: "/fake-identity" }],
    [{ endpoint: "/fake-identity", projectId: "kauro-local", adapter: "CONTRACT_FAKE" }, { adapter: "CONTRACT_FAKE", baseUrl: "/fake-identity" }],
    [{ adapter: "IDENTITY_PLATFORM", projectId: "kauro-live", endpoint: "/fake-identity" }, null],
    [{ adapter: "CONTRACT_FAKE", projectId: "kauro-local", endpoint: "https://identity.example" }, null],
    [{ adapter: "CONTRACT_FAKE", projectId: "kauro-local", endpoint: "/a/../b" }, null],
    [{ adapter: "IDENTITY_PLATFORM" }, null],
    [{ adapter: "CONTRACT_FAKE", projectId: "kauro-local" }, null],
    [{ adapter: "CONTRACT_FAKE", projectId: "kauro-local", endpoint: 7 }, null],
    [{ adapter: "CONTRACT_FAKE", projectId: "kauro-local", endpoint: "/x", extra: true }, null],
    [{ adapter: "LIVE" }, null],
    [{ adapter: "CONTRACT_FAKE", baseUrl: "/fake-identity" }, null],
    [{ adapter: "FIREBASE" }, null],
    [{ adapter: 1 }, null],
    [{}, null],
    [[], null],
    [null, null],
    ["LIVE", null],
    [undefined, null],
  ];
  for (const [value, expected] of cases) assert.deepEqual(readIdentityConfig(value), expected, JSON.stringify(value));
});

/** A minimal response of the api, as the fetch of a page would give it. */
function apiResponse(status: number, contentType: string | null, body: string): FetchedResponse {
  const headers = new Map<string, string>(contentType === null ? [] : [["content-type", contentType]]);
  return { status, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, text: async () => body };
}

function apiWith(answer: () => FetchedResponse) {
  const requests: Array<{ url: string; init: FetchInit }> = [];
  const client = new ApiClient({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return answer();
    },
    newCorrelationId: () => "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99",
    context: { csrfToken: () => null, activeAgency: () => null },
  });
  return { client, requests };
}

const SESSION_BODY = { userId: "0199c1a2-7b3d-7c4e-8a5f-000000000001", emailVerified: true, mfaEnrolled: true, mfaAt: "2026-09-29T10:00:00Z", stepUpFreshUntil: null, idleExpiresAt: "2026-09-29T10:30:00Z", absoluteExpiresAt: "2026-09-29T22:00:00Z", csrfToken: CSRF };

test("D-AUTH-4: a sign-in credential is exchanged for a session by sending its token once, and the credential is spent afterwards", async () => {
  const { transport } = scripted(signedIn());
  const { credential } = only(await new ContractFakeIdentityClient(transport).signIn(EMAIL, PASSWORD), "SIGNED_IN");
  const world = apiWith(() => apiResponse(201, "application/json", JSON.stringify(SESSION_BODY)));
  const answer = await createSession(world.client, credential);
  assert.equal(answer.kind, "REPLY");
  assert.equal(answer.kind === "REPLY" ? answer.body.csrfToken : null, CSRF);
  const [request] = world.requests;
  assert.ok(request);
  assert.equal(request.url, "/api/v1/sessions");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, JSON.stringify({ idToken: ID_TOKEN }));
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.credentials, "same-origin");
  assert.equal(Object.hasOwn(request.init.headers, "X-Kauro-CSRF"), false, "there is no token before the session");
  assert.equal(credential.spent, true);
  await assert.rejects(async () => createSession(world.client, credential), /already taken/, "the credential cannot open a second session");
  assert.equal(world.requests.length, 1);
});

test("D-AUTH-4: a step-up credential does not open a session, and its token stays unspent", async () => {
  const { transport } = scripted(signedIn());
  const { credential } = only(await new ContractFakeIdentityClient(transport).reauthenticate(EMAIL, PASSWORD), "SIGNED_IN");
  const world = apiWith(() => apiResponse(201, "application/json", JSON.stringify(SESSION_BODY)));
  await assert.rejects(async () => createSession(world.client, credential), RangeError);
  assert.equal(world.requests.length, 0);
  assert.equal(credential.spent, false, "the proof is still available to the step-up that needs it");
});

test("D-AUTH-4: a refused exchange is a Problem the page can act on, and a reply that does not match the session shape is never trusted", async () => {
  const { transport } = scripted(signedIn(), signedIn());
  const client = new ContractFakeIdentityClient(transport);
  const one = only(await client.signIn(EMAIL, PASSWORD), "SIGNED_IN").credential;
  const two = only(await client.signIn(EMAIL, PASSWORD), "SIGNED_IN").credential;
  const problem = { type: "urn:kauro:problem:AUTHENTICATION_REQUIRED", title: "x", status: 401, code: "AUTHENTICATION_REQUIRED", correlationId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99", retryable: false, nextActions: [] };
  const refused = await createSession(apiWith(() => apiResponse(401, "application/problem+json", JSON.stringify(problem))).client, one);
  assert.equal(refused.kind, "PROBLEM");
  const skewed = await createSession(apiWith(() => apiResponse(201, "application/json", JSON.stringify({ ...SESSION_BODY, extra: 1 }))).client, two);
  assert.equal(skewed.kind, "INTEGRITY");
});

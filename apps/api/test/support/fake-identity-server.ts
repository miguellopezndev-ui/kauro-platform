/**
 * The HTTP server of the identity provider's contract fake (B11 design §6: owner mandate W2; label CONTRACT_FAKE, evidence class
 * SIMULATED): the Identity Toolkit REST subset the browser suite's IdentityClient contract-fake adapter (W3) and the e2e launcher
 * (W6) use, served over the ContractFakeIdentityIssuer of @kauro/application/testing.
 *
 *   GET  /jwks.json                              the issuer's signing key (the api's CONTRACT_FAKE key source)
 *   POST /v1/accounts:signUp                     {email, password} → {idToken, localId, email, expiresIn}
 *   POST /v1/accounts:signInWithPassword         {email, password} → {idToken, localId, ...} | {mfaPendingCredential, mfaInfo}
 *   POST /v2/accounts/mfaSignIn:finalize         {mfaPendingCredential, mfaEnrollmentId, totpVerificationInfo:{verificationCode}}
 *   POST /v1/accounts:sendOobCode                {requestType: VERIFY_EMAIL, idToken} → {email}
 *   POST /v2/accounts/mfaEnrollment:start        {idToken, totpEnrollmentInfo:{}} → {totpSessionInfo}
 *   POST /v2/accounts/mfaEnrollment:finalize     {idToken, totpVerificationInfo:{sessionInfo, verificationCode}} → {idToken}
 *
 * Beside the Identity Toolkit subset it serves the wire of the web adapter (W3's contract-fake IdentityClient, protocol
 * `kauro-fake-identity-v1`, apps/web/src/client/identity/contract-fake.ts IDENTITY_FAKE_PROTOCOL; B11 design §12 D-W3-8, D-INT1-4):
 * six POST routes over the same issuer, JSON in and out, each 200 a closed {outcome, ...} and each refusal {error: <name>}:
 *
 *   POST /v1/sign-in, /v1/reauthenticate        {email, password}
 *   POST /v1/totp/verify, /v1/totp/enrol         {pendingToken, code}
 *   POST /v1/email/verification/send, /status    {pendingToken}
 *
 * The pending handle is this server's: it holds the step the sign-in waits for (the issuer's MFA credential, a started TOTP
 * enrolment, or an unverified e-mail with the password to resume the sign-in with), single use, five minutes on the issuer's
 * clock. A sign-in without a second factor goes on to enrolment, and every completed sign-in of an unverified e-mail stops at
 * EMAIL_UNVERIFIED, because the api admits neither (D-AUTH-4, the launch policy's verified e-mail and MFA).
 *
 * Refusals are 400 {error: {code: 400, message: <Identity Toolkit token>}}. Test controls live under /__test/ and stand in
 * for what a person does outside the application: POST /__test/accounts (create an account), /__test/verify-email (open the
 * verification link), /__test/totp (read the authenticator app), /__test/clock (move the fake's clock).
 *
 * Every answer carries X-Kauro-Fake: CONTRACT_FAKE and X-Kauro-Evidence-Class: SIMULATED and is never cacheable. A browser
 * origin must be one the server was given (Access-Control-Allow-Origin names it exactly, never a wildcard); any other origin
 * is refused with 403. The fake is a test fixture: it is never wired into a deployment, and the api refuses its key source
 * outside LOCAL.
 *
 * Run as a process (the e2e launcher): node dist/test/support/fake-identity-server.js --project <id> --jwks-file <path>
 * [--port <n>] [--origin <app origin>]... — it writes the JWKS to the file (the api's KAURO_IDENTITY_FAKE_JWKS_FILE), prints one
 * JSON line {url, jwksFile, projectId, label, evidenceClass} and serves until SIGTERM/SIGINT. Its clock is real time plus an
 * offset /__test/clock moves; the api process keeps its own clock.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACT_FAKE_LABEL, ContractFakeIdentityIssuer, SIMULATED_EVIDENCE, type FakeSignIn, type TestClock } from "@kauro/application/testing";
import { toUtcInstant } from "@kauro/domain";

export interface FakeIdentityServerOptions {
  readonly issuer: ContractFakeIdentityIssuer;
  readonly host?: string;
  readonly port?: number;
  /** The browser origins allowed to call the fake (exact). A request without Origin (a server, a test) is served. */
  readonly allowedOrigins?: ReadonlyArray<string>;
}

export interface FakeIdentityServer {
  readonly url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

function isTestClock(clock: unknown): clock is TestClock {
  return typeof clock === "object" && clock !== null && typeof (clock as TestClock).advance === "function" && typeof (clock as TestClock).set === "function";
}

/** Real time plus an offset that only moves forward: the clock of a fake serving a real browser. */
export function offsetClock(): TestClock {
  let offset = 0;
  return {
    now: () => toUtcInstant(Date.now() + offset),
    nowMs: () => Date.now() + offset,
    advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) throw new RangeError("the fake's clock only moves forward");
      offset += ms;
    },
    set(epochMs) {
      const current = Date.now() + offset;
      if (!Number.isInteger(epochMs) || epochMs < current) throw new RangeError("the fake's clock only moves forward");
      offset += epochMs - current;
    },
  };
}

type Answer = { readonly status: number; readonly body: unknown };

const refused = (message: string, status = 400): Answer => ({ status, body: { error: { code: status, message } } });

function stringOf(body: Record<string, unknown>, name: string): string | null {
  const v = body[name];
  return typeof v === "string" ? v : null;
}

function objectOf(body: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = body[name];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function signInAnswer(outcome: FakeSignIn, email: string | null): Answer {
  switch (outcome.kind) {
    case "SIGNED_IN":
      return { status: 200, body: { kind: "identitytoolkit#VerifyPasswordResponse", idToken: outcome.idToken, localId: outcome.localId, ...(email !== null ? { email } : {}), registered: true, expiresIn: "3600" } };
    case "MFA_REQUIRED":
      return { status: 200, body: { mfaPendingCredential: outcome.mfaPendingCredential, mfaInfo: [{ mfaEnrollmentId: outcome.mfaEnrollmentId, displayName: "Authenticator", totpInfo: {} }] } };
    case "REFUSED":
      return refused(outcome.code);
  }
}

// --- the web adapter's wire (kauro-fake-identity-v1) ----------------------------------------------------------------------------

/** The routes of the web adapter's protocol (W3, IDENTITY_FAKE_PROTOCOL.routes), relative to the fake's base. */
export const KAURO_FAKE_PROTOCOL_ROUTES = Object.freeze({
  signIn: "/v1/sign-in",
  reauthenticate: "/v1/reauthenticate",
  totpVerify: "/v1/totp/verify",
  totpEnrol: "/v1/totp/enrol",
  verificationSend: "/v1/email/verification/send",
  verificationStatus: "/v1/email/verification/status",
} as const);

const PROTOCOL_PENDING_LIFETIME_MS = 300_000;

type Pending =
  | { readonly kind: "TOTP"; readonly email: string; readonly password: string; readonly mfaPendingCredential: string; readonly mfaEnrollmentId: string; readonly expiresAtMs: number }
  | { readonly kind: "ENROLMENT"; readonly email: string; readonly password: string; readonly idToken: string; readonly sessionInfo: string; readonly expiresAtMs: number }
  | { readonly kind: "EMAIL"; readonly email: string; readonly password: string; readonly uid: string; readonly expiresAtMs: number };

const protocolRefusal = (error: "INVALID_CREDENTIALS" | "CODE_INVALID" | "NO_PENDING_STEP"): Answer => ({ status: 400, body: { error } });
const outcomeOf = (outcome: string, members: Readonly<Record<string, string>> = {}): Answer => ({ status: 200, body: { outcome, ...members } });

/** The pending steps of the protocol, over one issuer. */
function kauroProtocol(issuer: ContractFakeIdentityIssuer): (path: string, body: Record<string, unknown>) => Answer | null {
  const pending = new Map<string, Pending>();
  const hold = (step: Pending): string => {
    const handle = randomBytes(32).toString("base64url");
    pending.set(handle, step);
    return handle;
  };
  const take = (body: Record<string, unknown>, kind: Pending["kind"]): { readonly handle: string; readonly step: Pending } | null => {
    const handle = stringOf(body, "pendingToken");
    const step = handle === null ? undefined : pending.get(handle);
    if (handle === null || step === undefined) return null;
    if (step.expiresAtMs <= issuer.clock.nowMs()) {
      pending.delete(handle);
      return null;
    }
    return step.kind === kind ? { handle, step } : null;
  };
  const expiry = (): number => issuer.clock.nowMs() + PROTOCOL_PENDING_LIFETIME_MS;
  /** A completed sign-in: the token, unless the account's e-mail is still unverified (the api admits neither). */
  const signedIn = (idToken: string, email: string, password: string): Answer => {
    const uid = issuer.uidOf(idToken);
    const account = uid === null ? null : issuer.account(uid);
    if (uid === null || account === null) return protocolRefusal("INVALID_CREDENTIALS");
    if (!account.emailVerified) return outcomeOf("EMAIL_UNVERIFIED", { pendingToken: hold({ kind: "EMAIL", email, password, uid, expiresAtMs: expiry() }) });
    return outcomeOf("SIGNED_IN", { idToken });
  };
  /** The first step of a sign-in or a re-authentication: the password, then whatever the account still needs. */
  const begin = (email: string, password: string): Answer => {
    const first = issuer.signInWithPassword(email, password);
    switch (first.kind) {
      case "REFUSED":
        // an unknown account, a wrong password and a disabled account answer alike (R2-134: no account enumeration)
        return protocolRefusal("INVALID_CREDENTIALS");
      case "MFA_REQUIRED":
        return outcomeOf("TOTP_REQUIRED", { pendingToken: hold({ kind: "TOTP", email, password, mfaPendingCredential: first.mfaPendingCredential, mfaEnrollmentId: first.mfaEnrollmentId, expiresAtMs: expiry() }) });
      case "SIGNED_IN": {
        const account = issuer.account(first.localId);
        if (account === null) return protocolRefusal("INVALID_CREDENTIALS");
        if (!account.emailVerified) return outcomeOf("EMAIL_UNVERIFIED", { pendingToken: hold({ kind: "EMAIL", email, password, uid: account.uid, expiresAtMs: expiry() }) });
        // no second factor yet: the launch policy needs one, so the sign-in goes on to a TOTP enrolment
        const started = issuer.startTotpEnrollment(first.idToken);
        if (started.kind === "REFUSED") return protocolRefusal("INVALID_CREDENTIALS");
        const otpauthUri = `otpauth://totp/Kauro:${encodeURIComponent(account.email)}?secret=${started.sharedSecretKey}&issuer=Kauro&algorithm=SHA1&digits=6&period=30`;
        return outcomeOf("TOTP_ENROLMENT_REQUIRED", { pendingToken: hold({ kind: "ENROLMENT", email, password, idToken: first.idToken, sessionInfo: started.sessionInfo, expiresAtMs: expiry() }), otpauthUri });
      }
    }
  };
  return (path, body) => {
    switch (path) {
      case KAURO_FAKE_PROTOCOL_ROUTES.signIn:
      case KAURO_FAKE_PROTOCOL_ROUTES.reauthenticate: {
        const email = stringOf(body, "email");
        const password = stringOf(body, "password");
        if (email === null || password === null) return protocolRefusal("INVALID_CREDENTIALS");
        return begin(email, password);
      }
      case KAURO_FAKE_PROTOCOL_ROUTES.totpVerify: {
        const held = take(body, "TOTP");
        if (held === null || held.step.kind !== "TOTP") return protocolRefusal("NO_PENDING_STEP");
        const done = issuer.finalizeTotp(held.step.mfaPendingCredential, stringOf(body, "code") ?? "", held.step.mfaEnrollmentId);
        if (done.kind === "REFUSED") {
          if (done.code === "INVALID_CODE") return protocolRefusal("CODE_INVALID");
          pending.delete(held.handle);
          return protocolRefusal("NO_PENDING_STEP");
        }
        if (done.kind !== "SIGNED_IN") return protocolRefusal("NO_PENDING_STEP");
        pending.delete(held.handle);
        return signedIn(done.idToken, held.step.email, held.step.password);
      }
      case KAURO_FAKE_PROTOCOL_ROUTES.totpEnrol: {
        const held = take(body, "ENROLMENT");
        if (held === null || held.step.kind !== "ENROLMENT") return protocolRefusal("NO_PENDING_STEP");
        const done = issuer.finalizeTotpEnrollment(held.step.idToken, held.step.sessionInfo, stringOf(body, "code") ?? "");
        if (done.kind === "REFUSED") {
          if (done.code === "INVALID_CODE") return protocolRefusal("CODE_INVALID");
          pending.delete(held.handle);
          return protocolRefusal("NO_PENDING_STEP");
        }
        if (done.kind !== "SIGNED_IN") return protocolRefusal("NO_PENDING_STEP");
        pending.delete(held.handle);
        return signedIn(done.idToken, held.step.email, held.step.password);
      }
      case KAURO_FAKE_PROTOCOL_ROUTES.verificationSend: {
        const held = take(body, "EMAIL");
        // the verification link itself is the test's (POST /__test/verify-email stands in for the person opening it)
        return held === null ? protocolRefusal("NO_PENDING_STEP") : outcomeOf("SENT");
      }
      case KAURO_FAKE_PROTOCOL_ROUTES.verificationStatus: {
        const held = take(body, "EMAIL");
        if (held === null || held.step.kind !== "EMAIL") return protocolRefusal("NO_PENDING_STEP");
        const account = issuer.account(held.step.uid);
        if (account === null) return protocolRefusal("NO_PENDING_STEP");
        if (!account.emailVerified) return outcomeOf("EMAIL_UNVERIFIED", { pendingToken: held.handle });
        pending.delete(held.handle);
        return begin(held.step.email, held.step.password);
      }
      default:
        return null;
    }
  };
}

/** The routes of the fake, over one issuer. */
function answer(issuer: ContractFakeIdentityIssuer, method: string, path: string, body: Record<string, unknown>): Answer {
  if (method === "GET" && path === "/jwks.json") return { status: 200, body: issuer.jwks() };
  if (method !== "POST") return refused("NOT_FOUND", 404);
  switch (path) {
    case "/v1/accounts:signUp": {
      const email = stringOf(body, "email");
      const password = stringOf(body, "password");
      if (email === null || password === null) return refused("MISSING_EMAIL");
      const outcome = issuer.signUp(email, password);
      return outcome.kind === "SIGNED_IN" ? { status: 200, body: { kind: "identitytoolkit#SignupNewUserResponse", idToken: outcome.idToken, localId: outcome.localId, email, expiresIn: "3600" } } : signInAnswer(outcome, email);
    }
    case "/v1/accounts:signInWithPassword": {
      const email = stringOf(body, "email") ?? "";
      return signInAnswer(issuer.signInWithPassword(email, stringOf(body, "password") ?? ""), email);
    }
    case "/v2/accounts/mfaSignIn:finalize": {
      const code = stringOf(objectOf(body, "totpVerificationInfo"), "verificationCode") ?? "";
      const enrollment = stringOf(body, "mfaEnrollmentId");
      return signInAnswer(issuer.finalizeTotp(stringOf(body, "mfaPendingCredential") ?? "", code, enrollment ?? undefined), null);
    }
    case "/v1/accounts:sendOobCode": {
      if (stringOf(body, "requestType") !== "VERIFY_EMAIL") return refused("INVALID_REQ_TYPE");
      const uid = issuer.uidOf(stringOf(body, "idToken") ?? "");
      const account = uid === null ? null : issuer.account(uid);
      return account === null ? refused("INVALID_ID_TOKEN") : { status: 200, body: { kind: "identitytoolkit#GetOobConfirmationCodeResponse", email: account.email } };
    }
    case "/v2/accounts/mfaEnrollment:start": {
      const started = issuer.startTotpEnrollment(stringOf(body, "idToken") ?? "");
      if (started.kind === "REFUSED") return refused(started.code);
      const { kind: _kind, ...totpSessionInfo } = started;
      return { status: 200, body: { totpSessionInfo } };
    }
    case "/v2/accounts/mfaEnrollment:finalize": {
      const info = objectOf(body, "totpVerificationInfo");
      const outcome = issuer.finalizeTotpEnrollment(stringOf(body, "idToken") ?? "", stringOf(info, "sessionInfo") ?? "", stringOf(info, "verificationCode") ?? "");
      return outcome.kind === "SIGNED_IN" ? { status: 200, body: { idToken: outcome.idToken } } : signInAnswer(outcome, null);
    }
    // --- test controls: what a person does outside the application ---------------------------------------------------------
    case "/__test/accounts": {
      const uid = stringOf(body, "uid");
      const email = stringOf(body, "email");
      const password = stringOf(body, "password");
      if (uid === null || email === null || password === null) return refused("MISSING_ACCOUNT_FIELDS");
      try {
        const account = issuer.createAccount({ uid, email, password, emailVerified: body["emailVerified"] !== false, totp: body["totp"] !== false, disabled: body["disabled"] === true });
        return { status: 200, body: { uid: account.uid, email: account.email, emailVerified: account.emailVerified, mfaEnrolled: account.totpSecret !== null } };
      } catch {
        return refused("EMAIL_EXISTS");
      }
    }
    case "/__test/verify-email": {
      return issuer.verifyEmail(stringOf(body, "email") ?? "") ? { status: 200, body: { verified: true } } : refused("EMAIL_NOT_FOUND");
    }
    case "/__test/totp": {
      const uid = stringOf(body, "uid");
      const account = uid === null ? null : issuer.account(uid);
      if (account === null || account.totpSecret === null) return refused("MFA_NOT_ENROLLED");
      return { status: 200, body: { verificationCode: issuer.totpCodeFor(account.uid) } };
    }
    case "/__test/clock": {
      if (!isTestClock(issuer.clock)) return refused("CLOCK_NOT_CONTROLLABLE", 409);
      const advance = body["advanceMs"];
      const set = body["setMs"];
      try {
        if (typeof advance === "number") issuer.clock.advance(advance);
        else if (typeof set === "number") issuer.clock.set(set);
        else return refused("MISSING_CLOCK_MOVE");
      } catch {
        return refused("CLOCK_MOVES_FORWARD_ONLY");
      }
      return { status: 200, body: { now: issuer.clock.now() } };
    }
    default:
      return refused("NOT_FOUND", 404);
  }
}

export function startFakeIdentityServer(options: FakeIdentityServerOptions): Promise<FakeIdentityServer> {
  const allowed = new Set(options.allowedOrigins ?? []);
  const protocol = kauroProtocol(options.issuer);
  const server = http.createServer((req, res) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const headers: Record<string, string> = {
      "x-kauro-fake": CONTRACT_FAKE_LABEL,
      "x-kauro-evidence-class": SIMULATED_EVIDENCE,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    };
    const send = (a: Answer): void => {
      res.writeHead(a.status, headers);
      res.end(JSON.stringify(a.body));
    };
    if (origin !== null) {
      if (!allowed.has(origin)) return send(refused("ORIGIN_NOT_ALLOWED", 403));
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
    if (req.method === "OPTIONS") {
      headers["access-control-allow-methods"] = "GET, POST";
      headers["access-control-allow-headers"] = "content-type";
      headers["access-control-max-age"] = "600";
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return send(refused("BODY_TOO_LARGE", 413));
      let body: Record<string, unknown> = {};
      if (size > 0) {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return send(refused("INVALID_JSON"));
          body = parsed as Record<string, unknown>;
        } catch {
          return send(refused("INVALID_JSON"));
        }
      }
      const path = (req.url ?? "/").split("?")[0] as string;
      send((req.method === "POST" ? protocol(path, body) : null) ?? answer(options.issuer, req.method ?? "GET", path, body));
    });
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolveStart({
        url: `http://${options.host ?? "127.0.0.1"}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// --- as a process (the e2e launcher) -------------------------------------------------------------------------------------------

function argumentsOf(argv: ReadonlyArray<string>): { project: string; jwksFile: string; port: number; origins: string[] } {
  let project = "kauro-local";
  let jwksFile: string | null = null;
  let port = 0;
  const origins: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--project") project = value;
    else if (name === "--jwks-file") jwksFile = value;
    else if (name === "--port") port = Number(value);
    else if (name === "--origin") origins.push(value);
    else throw new Error(`unknown argument ${name}`);
  }
  if (jwksFile === null) throw new Error("--jwks-file is required: the api reads the fake's key from it (KAURO_IDENTITY_FAKE_JWKS_FILE)");
  return { project, jwksFile, port, origins };
}

async function main(): Promise<void> {
  const args = argumentsOf(process.argv.slice(2));
  const issuer = new ContractFakeIdentityIssuer({ projectId: args.project, clock: offsetClock() });
  writeFileSync(args.jwksFile, JSON.stringify(issuer.jwks()));
  const server = await startFakeIdentityServer({ issuer, port: args.port, allowedOrigins: args.origins });
  process.stdout.write(`${JSON.stringify({ url: server.url, jwksFile: args.jwksFile, projectId: issuer.projectId, label: CONTRACT_FAKE_LABEL, evidenceClass: SIMULATED_EVIDENCE })}\n`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e: unknown) => {
    process.stderr.write(`fake identity server failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

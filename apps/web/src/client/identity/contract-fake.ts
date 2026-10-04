// CONTRACT_FAKE, evidence class SIMULATED (design section 6): the web adapter of IdentityClient that speaks to the fake identity issuer's
// HTTP server (W2's `apps/api/test/support/fake-identity-server.ts`). It stands in for the identity provider until the live adapter exists
// (W-IDP-LIVE, blocked on the owner's Google Cloud project); the api announces it only when KAURO_ENV is LOCAL, and `selectIdentityClient`
// builds it only when that announcement says so.
//
// The wire it speaks is the pinned protocol below: six POST routes, JSON in and out, one closed reply shape per route. The server side is
// W2's; the integration mandate makes the two agree (any difference is a change to one constant, IDENTITY_FAKE_PROTOCOL, or to the
// server). Nothing about this file is evidence that a real provider behaves this way.
import type { FetchedResponse, FetchInit, FetchLike } from "../api-client.ts";
import {
  type CredentialPurpose,
  IdentityCredential,
  type IdentityClient,
  type IdentityEvidence,
  type IdentityFailure,
  type IdentitySource,
  type IdentityStep,
  SIGN_IN_CODE,
} from "./port.ts";

export const IDENTITY_FAKE_PROTOCOL = {
  version: "kauro-fake-identity-v1",
  routes: {
    signIn: "/v1/sign-in",
    reauthenticate: "/v1/reauthenticate",
    totpVerify: "/v1/totp/verify",
    totpEnrol: "/v1/totp/enrol",
    verificationSend: "/v1/email/verification/send",
    verificationStatus: "/v1/email/verification/status",
  },
  /** The `error` member of a 4xx reply. Anything else is a protocol error. */
  errors: ["INVALID_CREDENTIALS", "CODE_INVALID", "TOO_MANY_ATTEMPTS", "NO_PENDING_STEP"],
  /** The `outcome` member of a 200 reply, with the members each one carries and nothing else. */
  outcomes: {
    SIGNED_IN: ["idToken"],
    TOTP_REQUIRED: ["pendingToken"],
    TOTP_ENROLMENT_REQUIRED: ["pendingToken", "otpauthUri"],
    EMAIL_UNVERIFIED: ["pendingToken"],
    SENT: [],
  },
} as const;

export interface IdentityTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Sends one protocol request; null when no readable answer came back. */
export type IdentityTransport = (route: string, body: Readonly<Record<string, string>>) => Promise<IdentityTransportResponse | null>;

const BASE_URL = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const PENDING_TOKEN = /^[A-Za-z0-9._-]{1,2048}$/;
const ID_TOKEN = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{0,4096}$/;
const OTPAUTH = /^otpauth:\/\/totp\/[^\s]{1,2000}$/;

/** The transport of a page: same-origin fetch of `baseUrl` (a path on this origin, never another host), never cached, no redirect followed. */
export function fetchIdentityTransport(fetch: FetchLike, baseUrl: string): IdentityTransport {
  if (!BASE_URL.test(baseUrl) || baseUrl.split("/").some((segment) => segment === "." || segment === "..")) throw new RangeError("the fake identity server is a path on this origin");
  return async (route, body) => {
    const init: FetchInit = {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "same-origin",
    };
    let response: FetchedResponse;
    try {
      response = await fetch(`${baseUrl}${route}`, init);
    } catch {
      return null;
    }
    try {
      return { status: response.status, body: JSON.parse(await response.text()) as unknown };
    } catch {
      return { status: response.status, body: undefined };
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
}

/** Exactly these members, each a string that passes its own test; anything else is not a reply of this protocol. */
function strings(body: Record<string, unknown>, names: readonly string[], tests: Readonly<Record<string, RegExp>>): Record<string, string> | null {
  const keys = Object.keys(body).filter((key) => key !== "outcome");
  if (keys.length !== names.length || !names.every((name) => Object.hasOwn(body, name))) return null;
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = body[name];
    const test = tests[name];
    if (typeof value !== "string" || test === undefined || !test.test(value)) return null;
    out[name] = value;
  }
  return out;
}

type Reply =
  | { readonly kind: "SIGNED_IN"; readonly idToken: string }
  | { readonly kind: "TOTP_REQUIRED"; readonly pendingToken: string }
  | { readonly kind: "TOTP_ENROLMENT_REQUIRED"; readonly pendingToken: string; readonly otpauthUri: string }
  | { readonly kind: "EMAIL_UNVERIFIED"; readonly pendingToken: string }
  | { readonly kind: "SENT" }
  | { readonly kind: "FAILED"; readonly failure: IdentityFailure };

function readReply(answer: IdentityTransportResponse | null): Reply {
  if (answer === null || answer.status >= 500 || answer.status === 0) return { kind: "FAILED", failure: "UNAVAILABLE" };
  const body = answer.body;
  if (!isPlainObject(body)) return { kind: "FAILED", failure: "PROTOCOL_ERROR" };
  if (answer.status >= 400 && answer.status < 500) {
    const failure = body["error"];
    const known = IDENTITY_FAKE_PROTOCOL.errors as readonly string[];
    return Object.keys(body).length === 1 && typeof failure === "string" && known.includes(failure) ? { kind: "FAILED", failure: failure as IdentityFailure } : { kind: "FAILED", failure: "PROTOCOL_ERROR" };
  }
  if (answer.status !== 200) return { kind: "FAILED", failure: "PROTOCOL_ERROR" };
  const protocolError: Reply = { kind: "FAILED", failure: "PROTOCOL_ERROR" };
  const outcome = body["outcome"];
  if (typeof outcome !== "string" || !Object.hasOwn(IDENTITY_FAKE_PROTOCOL.outcomes, outcome)) return protocolError;
  const members = IDENTITY_FAKE_PROTOCOL.outcomes[outcome as keyof typeof IDENTITY_FAKE_PROTOCOL.outcomes] as readonly string[];
  const read = strings(body, members, { idToken: ID_TOKEN, pendingToken: PENDING_TOKEN, otpauthUri: OTPAUTH });
  if (read === null) return protocolError;
  switch (outcome) {
    case "SIGNED_IN":
      return { kind: "SIGNED_IN", idToken: read["idToken"] as string };
    case "TOTP_REQUIRED":
      return { kind: "TOTP_REQUIRED", pendingToken: read["pendingToken"] as string };
    case "TOTP_ENROLMENT_REQUIRED":
      return { kind: "TOTP_ENROLMENT_REQUIRED", pendingToken: read["pendingToken"] as string, otpauthUri: read["otpauthUri"] as string };
    case "EMAIL_UNVERIFIED":
      return { kind: "EMAIL_UNVERIFIED", pendingToken: read["pendingToken"] as string };
    default:
      return { kind: "SENT" };
  }
}

/** What the sign-in in progress is waiting for: a step answers only the one it was offered. */
type Awaiting = "TOTP" | "ENROLMENT" | "EMAIL";

export class ContractFakeIdentityClient implements IdentityClient {
  readonly source: IdentitySource = "CONTRACT_FAKE";
  readonly evidence: IdentityEvidence = "SIMULATED";
  readonly #transport: IdentityTransport;
  /** The provider's handle on the sign-in in progress, and the one step it answers. Held only here, cleared on every end of the flow. */
  #pending: { readonly handle: string; readonly awaiting: Awaiting } | null = null;
  #purpose: CredentialPurpose = "SESSION";
  readonly #inFlight = new Map<string, Promise<IdentityStep>>();

  constructor(transport: IdentityTransport) {
    this.#transport = transport;
  }

  signIn(email: string, password: string): Promise<IdentityStep> {
    return this.#credentials("signIn", IDENTITY_FAKE_PROTOCOL.routes.signIn, "SESSION", email, password);
  }

  reauthenticate(email: string, password: string): Promise<IdentityStep> {
    return this.#credentials("reauthenticate", IDENTITY_FAKE_PROTOCOL.routes.reauthenticate, "STEP_UP", email, password);
  }

  submitTotp(code: string): Promise<IdentityStep> {
    return this.#withPending("submitTotp", IDENTITY_FAKE_PROTOCOL.routes.totpVerify, "TOTP", code);
  }

  enrolTotp(code: string): Promise<IdentityStep> {
    return this.#withPending("enrolTotp", IDENTITY_FAKE_PROTOCOL.routes.totpEnrol, "ENROLMENT", code);
  }

  async resendVerification(): Promise<IdentityStep> {
    return this.#single("resendVerification", async () => {
      const pending = this.#pending;
      if (pending === null || pending.awaiting !== "EMAIL") return { kind: "FAILED", failure: "NO_PENDING_STEP" };
      const reply = readReply(await this.#transport(IDENTITY_FAKE_PROTOCOL.routes.verificationSend, { pendingToken: pending.handle }));
      if (reply.kind === "SENT") return { kind: "VERIFICATION_SENT" };
      return this.#step(reply);
    });
  }

  async checkVerification(): Promise<IdentityStep> {
    return this.#single("checkVerification", async () => {
      const pending = this.#pending;
      if (pending === null || pending.awaiting !== "EMAIL") return { kind: "FAILED", failure: "NO_PENDING_STEP" };
      return this.#step(readReply(await this.#transport(IDENTITY_FAKE_PROTOCOL.routes.verificationStatus, { pendingToken: pending.handle })));
    });
  }

  cancel(): void {
    this.#pending = null;
    this.#purpose = "SESSION";
  }

  #credentials(name: string, route: string, purpose: CredentialPurpose, email: string, password: string): Promise<IdentityStep> {
    return this.#single(name, async () => {
      if (!EMAIL.test(email) || password.length === 0 || password.length > 1024) return { kind: "FAILED", failure: "INVALID_CREDENTIALS" };
      this.cancel();
      this.#purpose = purpose;
      return this.#step(readReply(await this.#transport(route, { email, password })));
    });
  }

  #withPending(name: string, route: string, awaiting: Awaiting, code: string): Promise<IdentityStep> {
    return this.#single(name, async () => {
      const pending = this.#pending;
      if (pending === null || pending.awaiting !== awaiting) return { kind: "FAILED", failure: "NO_PENDING_STEP" };
      if (!SIGN_IN_CODE.test(code)) return { kind: "FAILED", failure: "CODE_INVALID" };
      return this.#step(readReply(await this.#transport(route, { pendingToken: pending.handle, code })));
    });
  }

  /** A second activation of the same step while it is out joins it: one request, one answer. */
  #single(name: string, run: () => Promise<IdentityStep>): Promise<IdentityStep> {
    const running = this.#inFlight.get(name);
    if (running !== undefined) return running;
    const started = run().finally(() => {
      this.#inFlight.delete(name);
    });
    this.#inFlight.set(name, started);
    return started;
  }

  /** Applies a reply to the flow: what the person does next, and what this object still remembers. */
  #step(reply: Reply): IdentityStep {
    switch (reply.kind) {
      case "SIGNED_IN": {
        const purpose = this.#purpose;
        this.cancel();
        return { kind: "SIGNED_IN", credential: new IdentityCredential(this.source, purpose, reply.idToken) };
      }
      case "TOTP_REQUIRED":
        this.#pending = { handle: reply.pendingToken, awaiting: "TOTP" };
        return { kind: "TOTP_REQUIRED" };
      case "TOTP_ENROLMENT_REQUIRED":
        this.#pending = { handle: reply.pendingToken, awaiting: "ENROLMENT" };
        return { kind: "TOTP_ENROLMENT_REQUIRED", enrolment: { otpauthUri: reply.otpauthUri } };
      case "EMAIL_UNVERIFIED":
        this.#pending = { handle: reply.pendingToken, awaiting: "EMAIL" };
        return { kind: "EMAIL_UNVERIFIED" };
      case "SENT":
        // a "sent" answer where a sign-in step was expected is not part of the protocol, and a flow that got one cannot be trusted further
        this.cancel();
        return { kind: "FAILED", failure: "PROTOCOL_ERROR" };
      case "FAILED":
        // a wrong code and a lost connection may be tried again; every other failure ends the flow
        if (reply.failure !== "CODE_INVALID" && reply.failure !== "UNAVAILABLE") this.cancel();
        return { kind: "FAILED", failure: reply.failure };
    }
  }
}

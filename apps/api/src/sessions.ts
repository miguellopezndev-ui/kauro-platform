/**
 * The browser session boundary of the api (B11 design D-AUTH-1..5; 08 "Authentication and assurance", "Browser, API and cache
 * isolation"): the SessionAuthenticator every command and read authenticates with once the boundary is bound, and the five
 * routes of the boundary — operational routes of @kauro/application (SESSION_ROUTES), with closed request and reply schemas and
 * closed outcome catalogues the send guard enforces like any command's:
 *
 *   POST /api/v1/sessions                  {idToken} → 201 SessionView + Set-Cookie __Host-kauro_session (exact Origin required)
 *   GET  /api/v1/sessions/current          → 200 SessionView | 401
 *   POST /api/v1/sessions/current/revoke   → 204, cookie cleared, Clear-Site-Data "cache", "cookies", "storage" (idempotent)
 *   POST /api/v1/assurance/step-ups        {idToken} → 201 {proofId, expiresAt}: a B06 STEP_UP proof CMD025 cites
 *   GET  /api/v1/public/identity-config    → 200 {adapter, projectId[, endpoint]}: which identity client the page loads
 *
 * The SessionAuthenticator implements B06's Authenticator from the Cookie header: exactly one __Host-kauro_session (two, or one
 * beside an Authorization header, is AMBIGUOUS_CREDENTIALS); for an unsafe method the exact Origin, a same-origin
 * Sec-Fetch-Site and the session's CSRF token, all decided before the command journal is reserved; then the live session of the
 * secret. A request without a session cookie falls through to the bearer authenticator the deployment binds (LOCAL only). No
 * route ever sends a CORS header: the browser calls the api on its own origin (D-TOPO-1).
 *
 * GET /api/v1/sessions/current is the page's session probe (D-PRIV-1: re-read on pageshow and visibilitychange): its 401 is not a
 * refused access to a resource, so it records no denial fact; every other refusal here does.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthenticatedSubject, Problem, SchemaValidator, SessionService, UnauthenticatedRequest, IdentityTokenVerifier, WebSessionStore } from "@kauro/application";
import {
  CLEAR_SITE_DATA,
  SESSION_ACTIONS,
  SESSION_OPERATION_IDS,
  SESSION_ROUTES,
  admitEmptyRequest,
  admitHeaders,
  admitOperationalBody,
  assertApplicationOrigin,
  clearedSessionCookie,
  internalProblem,
  operationalRouteResponses,
  presentedCredential,
  problemOf,
  repeatedHeaderNames,
  sessionCookie,
  unauthenticatedProblem,
} from "@kauro/application";
import type { CorrelationId, Environment } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { authenticationOf, type Authentication, type AuthenticationRequest, type Authenticator, type HeldCredential } from "./authenticator.js";
import { sendProblem, singleValued } from "./http.js";

/** What GET /api/v1/public/identity-config answers (D-AUTH-2). */
export interface IdentityConfigView {
  readonly adapter: "IDENTITY_PLATFORM" | "CONTRACT_FAKE";
  readonly projectId: string;
  /** Where the page reaches the contract fake: a path of the application origin the edge routes to it (LOCAL only). */
  readonly endpoint?: string;
}

/** The session boundary a deployment binds (composition: assembleApi's `sessions`). */
export interface SessionAssembly {
  readonly verifier: IdentityTokenVerifier;
  /** The authentication boundary's store (PgWebSessionStore over the kauro_assurance pool). */
  readonly store: WebSessionStore;
  /** The exact browser origins of the application (KAURO_APP_ORIGINS). */
  readonly appOrigins: ReadonlyArray<string>;
  readonly identityConfig: IdentityConfigView;
}

/** Refuses an identity configuration the environment does not allow: the contract fake is announced in LOCAL only (D-AUTH-2). */
export function assertIdentityConfig(environment: Environment, config: IdentityConfigView): void {
  if (config.adapter === "CONTRACT_FAKE" && environment !== "LOCAL") {
    throw new Error(`the CONTRACT_FAKE identity adapter is announced in the LOCAL environment only, never in ${environment} (B11 design D-AUTH-2)`);
  }
  if (config.adapter !== "CONTRACT_FAKE" && config.endpoint !== undefined) throw new Error("only the contract fake announces an endpoint");
}

/**
 * The authenticator of an api whose session boundary is bound: the session cookie (with the CSRF rule of D-AUTH-5), and beside
 * it the bearer authenticator the deployment binds for requests that carry no cookie (LOCAL bearer file, tests).
 */
export function createSessionAuthenticator(bearer: Authenticator, service: SessionService, appOrigins: ReadonlyArray<string>): Authenticator {
  const authenticateRequest = async (request: AuthenticationRequest): Promise<Authentication> => {
    let credential;
    try {
      credential = presentedCredential(request, appOrigins);
    } catch (e) {
      if (e instanceof DomainFailure) return { kind: "REFUSED", failure: e };
      throw e;
    }
    switch (credential.kind) {
      case "NONE":
        return { kind: "NONE" };
      case "BEARER": {
        const subject = await bearer.authenticate(request.headers);
        return subject === null ? { kind: "NONE" } : { kind: "SUBJECT", subject, sessionSecret: null };
      }
      case "SESSION": {
        if (credential.secret === null) return { kind: "NONE" };
        const resumed = await service.resume(credential.secret);
        if (resumed === null) return { kind: "NONE" };
        const { idleExpiresAt, absoluteExpiresAt } = resumed.session;
        const liveUntil = Date.parse(idleExpiresAt) <= Date.parse(absoluteExpiresAt) ? idleExpiresAt : absoluteExpiresAt;
        return { kind: "SUBJECT", subject: resumed.subject, sessionSecret: credential.secret, liveUntil };
      }
    }
  };
  // rule 16 (PV1R-02, PV1R-07 r3): the credential of a guarded effect, held under the session row's lock until the route releases it
  const holdRequest = async (request: AuthenticationRequest): Promise<HeldCredential | null> => {
    let credential;
    try {
      credential = presentedCredential(request, appOrigins);
    } catch (e) {
      if (e instanceof DomainFailure) return null;
      throw e;
    }
    switch (credential.kind) {
      case "NONE":
        return null;
      case "BEARER": {
        const subject = await bearer.authenticate(request.headers);
        return subject === null ? null : { userId: subject.identity.userId, liveAt: () => true, release: async () => undefined };
      }
      case "SESSION": {
        if (credential.secret === null) return null;
        const held = await service.hold(credential.secret);
        return held === null ? null : { userId: held.subject.identity.userId, liveAt: (nowMs) => held.liveAt(nowMs), release: () => held.release() };
      }
    }
  };
  return {
    authenticateRequest,
    holdRequest,
    // B06's form knows no method: it is a safe request's authentication (no CSRF rule); the server uses authenticateRequest
    async authenticate(headers): Promise<AuthenticatedSubject | null> {
      const a = await authenticateRequest({ method: "GET", headers });
      return a.kind === "SUBJECT" ? a.subject : null;
    },
  };
}

export interface SessionRoutesOptions {
  readonly service: SessionService;
  /** The api's authenticator (the session authenticator): the step-up's caller. */
  readonly authenticator: Authenticator;
  readonly appOrigins: ReadonlyArray<string>;
  readonly identityConfig: IdentityConfigView;
  readonly validator: SchemaValidator;
  readonly refuseUnauthenticated: (action: string, request: UnauthenticatedRequest) => Promise<Problem>;
  readonly refuseCredentials: (action: string, request: UnauthenticatedRequest, failure: DomainFailure) => Promise<Problem>;
  readonly sink: (correlationId: string, error: unknown) => void;
}

function routeOf(operationId: string) {
  const route = SESSION_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`the session route ${operationId} is not declared in SESSION_ROUTES of @kauro/application`);
  return route;
}

const JSON_CONTENT_TYPE = "application/json";

export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  const open = routeOf(SESSION_OPERATION_IDS.open);
  const current = routeOf(SESSION_OPERATION_IDS.current);
  const revoke = routeOf(SESSION_OPERATION_IDS.revoke);
  const stepUp = routeOf(SESSION_OPERATION_IDS.stepUp);
  const identityConfig = routeOf(SESSION_OPERATION_IDS.identityConfig);

  const headOf = (request: FastifyRequest) => ({ headers: singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
  const bodyOf = (request: FastifyRequest): Buffer | null => (Buffer.isBuffer(request.body) ? request.body : null);
  const queryOf = (request: FastifyRequest): Readonly<Record<string, unknown>> => (typeof request.query === "object" && request.query !== null ? (request.query as Record<string, unknown>) : {});
  // a JSON body's head (repeated envelope header, content type) is admitted before the body is read, as a command's is
  const earlyHead = async (request: FastifyRequest, reply: Parameters<typeof sendProblem>[0]) => {
    const early = admitHeaders(headOf(request));
    return early === null ? undefined : sendProblem(reply, early.problem);
  };
  const failed = (correlationId: string, error: unknown): Problem => {
    options.sink(correlationId, error);
    return internalProblem(correlationId);
  };

  app.route({
    method: open.method,
    url: open.path,
    config: { responses: operationalRouteResponses(open.operationId) },
    onRequest: earlyHead,
    handler: async (request, reply) => {
      const head = headOf(request);
      const admitted = admitOperationalBody<{ idToken: string }>(open, { ...head, body: bodyOf(request) }, options.validator);
      if (admitted.kind === "PROBLEM") return sendProblem(reply, admitted.problem);
      const refused: UnauthenticatedRequest = { correlationId: head.correlationId, agencyId: null };
      let replacing: string | null = null;
      try {
        // the sign-in presents an identity token: a session cookie beside a bearer token, two session cookies, or a bearer token
        // beside the identity token are more than one claimed identity; and it comes from the application's own page (login CSRF)
        const credential = presentedCredential({ method: request.method, headers: head.headers }, options.appOrigins, false);
        if (credential.kind === "BEARER") throw new DomainFailure("INVALID_REQUEST", "a sign-in presents its identity token only", { reason: "AMBIGUOUS_CREDENTIALS" });
        if (credential.kind === "SESSION") replacing = credential.secret;
        assertApplicationOrigin(head.headers, options.appOrigins);
      } catch (e) {
        if (!(e instanceof DomainFailure)) throw e;
        return sendProblem(reply, await options.refuseCredentials(SESSION_ACTIONS.open, refused, e).catch((error: unknown) => failed(head.correlationId, error)));
      }
      let opened;
      try {
        opened = await options.service.open({ correlationId: head.correlationId, idToken: admitted.body.idToken, replacing });
      } catch (error) {
        return sendProblem(reply, failed(head.correlationId, error));
      }
      if (opened.kind === "PROBLEM") return sendProblem(reply, opened.problem);
      return reply.code(201).header("set-cookie", sessionCookie(opened.value.secret)).type(JSON_CONTENT_TYPE).send(opened.value.view);
    },
  });

  app.route({
    method: current.method,
    url: current.path,
    config: { responses: operationalRouteResponses(current.operationId) },
    handler: async (request, reply) => {
      const head = headOf(request);
      const refusal = admitEmptyRequest({ ...head, body: bodyOf(request), query: queryOf(request) });
      if (refusal !== null) return sendProblem(reply, refusal.problem);
      let credential;
      try {
        credential = presentedCredential({ method: request.method, headers: head.headers }, options.appOrigins);
      } catch (e) {
        if (!(e instanceof DomainFailure)) throw e;
        // the session probe records no fact, a refused credential included
        return sendProblem(reply, problemOf(e, head.correlationId));
      }
      if (credential.kind !== "SESSION" || credential.secret === null) return sendProblem(reply, unauthenticatedProblem(head.correlationId));
      const secret = credential.secret;
      let resumed;
      try {
        resumed = await options.service.resume(secret);
      } catch (error) {
        if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return sendProblem(reply, problemOf(error, head.correlationId));
        return sendProblem(reply, failed(head.correlationId, error));
      }
      if (resumed === null) return sendProblem(reply, unauthenticatedProblem(head.correlationId));
      return reply.code(200).type(JSON_CONTENT_TYPE).send(options.service.viewOf(secret, resumed.session));
    },
  });

  app.route({
    method: revoke.method,
    url: revoke.path,
    config: { responses: operationalRouteResponses(revoke.operationId) },
    handler: async (request, reply) => {
      const head = headOf(request);
      const refusal = admitEmptyRequest({ ...head, body: bodyOf(request), query: queryOf(request) });
      if (refusal !== null) return sendProblem(reply, refusal.problem);
      let credential;
      try {
        credential = presentedCredential({ method: request.method, headers: head.headers }, options.appOrigins);
      } catch (e) {
        if (!(e instanceof DomainFailure)) throw e;
        return sendProblem(reply, await options.refuseCredentials(SESSION_ACTIONS.revoke, { correlationId: head.correlationId, agencyId: null }, e).catch((error: unknown) => failed(head.correlationId, error)));
      }
      if (credential.kind === "SESSION") {
        let revoked;
        try {
          revoked = await options.service.revoke({ correlationId: head.correlationId, secret: credential.secret });
        } catch (error) {
          return sendProblem(reply, failed(head.correlationId, error));
        }
        if (revoked.kind === "PROBLEM") return sendProblem(reply, revoked.problem);
      }
      // the same clearing answer whether a session was ended now, was already ended, or no cookie came (idempotent logout)
      return reply.code(204).header("set-cookie", clearedSessionCookie()).header("clear-site-data", CLEAR_SITE_DATA).send();
    },
  });

  app.route({
    method: stepUp.method,
    url: stepUp.path,
    config: { responses: operationalRouteResponses(stepUp.operationId) },
    onRequest: earlyHead,
    handler: async (request, reply) => {
      const head = headOf(request);
      const admitted = admitOperationalBody<{ idToken: string }>(stepUp, { ...head, body: bodyOf(request) }, options.validator);
      if (admitted.kind === "PROBLEM") return sendProblem(reply, admitted.problem);
      const refused: UnauthenticatedRequest = { correlationId: head.correlationId, agencyId: null };
      let authentication: Authentication;
      try {
        authentication = await authenticationOf(options.authenticator, { method: request.method, headers: head.headers });
      } catch (error) {
        if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return sendProblem(reply, problemOf(error, head.correlationId));
        return sendProblem(reply, failed(head.correlationId, error));
      }
      if (authentication.kind === "REFUSED") return sendProblem(reply, await options.refuseCredentials(SESSION_ACTIONS.stepUp, refused, authentication.failure).catch((error: unknown) => failed(head.correlationId, error)));
      if (authentication.kind === "NONE") return sendProblem(reply, await options.refuseUnauthenticated(SESSION_ACTIONS.stepUp, refused).catch((error: unknown) => failed(head.correlationId, error)));
      let issued;
      try {
        issued = await options.service.stepUp({ correlationId: head.correlationId, subject: authentication.subject, secret: authentication.sessionSecret, idToken: admitted.body.idToken });
      } catch (error) {
        return sendProblem(reply, failed(head.correlationId, error));
      }
      if (issued.kind === "PROBLEM") return sendProblem(reply, issued.problem);
      return reply.code(201).type(JSON_CONTENT_TYPE).send(issued.value);
    },
  });

  app.route({
    method: identityConfig.method,
    url: identityConfig.path,
    config: { responses: operationalRouteResponses(identityConfig.operationId) },
    handler: async (request, reply) => {
      const head = headOf(request);
      const refusal = admitEmptyRequest({ ...head, body: bodyOf(request), query: queryOf(request) });
      if (refusal !== null) return sendProblem(reply, refusal.problem);
      return reply.code(200).type(JSON_CONTENT_TYPE).send(options.identityConfig);
    },
  });
}

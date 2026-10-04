/**
 * The two public routes of the api (B11 W5b, D-PUB-1..D-PUB-8), for a caller who has not signed in:
 *
 *   GET  /api/v1/public/capability-publication   the service modes that admit real customers; no credential, never cached
 *   POST /api/v1/public/inquiries                a fit inquiry; the Origin must be exactly the public or the application origin
 *
 * Neither route reads a credential: an Authorization header or a cookie changes nothing, and no reply sets a cookie or a
 * cross-origin header (D-SEC-1: the api never answers a browser from another origin, so a preflight has no route and is a 404).
 * The Origin of an inquiry is decided first, in the route's `onRequest` hook, before the content type, the size or a byte of the
 * body is looked at (D-AUTH-5: the exact string, an absent header refused): a refused origin writes nothing and spends nothing.
 * After it the admission is the order of manual 10 — envelope headers, content type, size, strict UTF-8 JSON, the route's closed
 * schema — then the service of @kauro/application (detector, keyed digests, the store's replay and limiters).
 *
 * Both routes declare their replies with `operationalRouteResponses` like every route, so the send guard checks each reply, and
 * the OpenAPI document and its checker cover them.
 */
import type { FastifyInstance } from "fastify";
import type { CapabilityPublication, Clock, CorrelationId, IdGenerator, InquiryStore } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { InquiryBody, Problem, RawRequest, SchemaValidator } from "@kauro/application";
import {
  HEADERS,
  OPERATIONAL_ROUTES,
  admitEmptyRequest,
  admitHeaders,
  admitOperationalBody,
  internalProblem,
  operationalRouteResponses,
  problemOf,
  receiveInquiry,
  repeatedHeaderNames,
} from "@kauro/application";
import { sendProblem, singleValued } from "./http.js";

/** The two origins a browser may submit an inquiry from: the public site and the application (D-TOPO-2). */
export interface PublicOrigins {
  readonly public: string;
  readonly app: string;
}

/** What the composition binds for the public routes. */
export interface PublicApiOptions {
  readonly origins: PublicOrigins;
  readonly inquiries: InquiryStore;
  readonly capabilities: CapabilityPublication;
  /** At least 32 bytes, stable across the instances that share the database (the digests of the limiters and the replay). */
  readonly hashKey: Uint8Array;
}

export interface PublicRoutesOptions extends PublicApiOptions {
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The network a client address stands for in the limiter (IPv6 as its /64), or null when the address is unknown. */
  readonly clientNetwork: (address: string | undefined) => string | null;
  /** Receives every unexpected exception with its correlation id. */
  readonly sink: (correlationId: string, error: unknown) => void;
  /** Receives the cause of every CAPACITY_UNAVAILABLE answer with its correlation id. */
  readonly onUnavailable: (correlationId: string, cause: unknown) => void;
}

export const PUBLICATION_OPERATION = "getCapabilityPublication";
export const INQUIRY_OPERATION = "createInquiry";

/** The exact origin strings: an origin has a scheme, a host and an optional port, no path, no trailing slash, no comma. */
export function assertOrigin(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError(`${name} is not an origin`);
  }
  if (parsed.origin !== value || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) throw new RangeError(`${name} must be an origin of the form https://host[:port] as a browser writes it`);
}

const originRejected = (correlationId: string): Problem => problemOf(new DomainFailure("NOT_AUTHORIZED", "the request's Origin is not the public or the application origin", { reason: "ORIGIN_REJECTED" }), correlationId);

function operationOf(operationId: string) {
  const route = OPERATIONAL_ROUTES.find((r) => r.operationId === operationId);
  if (route === undefined) throw new Error(`the operational route ${operationId} is not declared`);
  return route;
}

/** The problem a failure of the work is answered with: a typed refusal as itself, anything else opaquely under the correlation id. */
function answerOf(error: unknown, correlationId: string, options: PublicRoutesOptions): Problem {
  if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") {
    if (error.code === "CAPACITY_UNAVAILABLE") options.onUnavailable(correlationId, error.cause ?? error);
    else if (error.code === "INTEGRITY_FAILURE") options.sink(correlationId, error);
    return problemOf(error, correlationId);
  }
  options.sink(correlationId, error);
  return internalProblem(correlationId);
}

export function registerPublicRoutes(app: FastifyInstance, options: PublicRoutesOptions): void {
  assertOrigin("the public origin", options.origins.public);
  assertOrigin("the application origin", options.origins.app);
  const allowed: ReadonlySet<string> = new Set([options.origins.public, options.origins.app]);
  const inquiryRoute = operationOf(INQUIRY_OPERATION);
  const publicationRoute = operationOf(PUBLICATION_OPERATION);

  app.route({
    method: publicationRoute.method,
    url: publicationRoute.path,
    config: { responses: operationalRouteResponses(PUBLICATION_OPERATION) },
    handler: async (request, reply) => {
      const correlationId = request.id as CorrelationId;
      const refusal = admitEmptyRequest({
        headers: singleValued(request.headers),
        repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders),
        correlationId,
        body: Buffer.isBuffer(request.body) ? request.body : null,
        query: request.query as Readonly<Record<string, unknown>>,
      });
      if (refusal !== null) return sendProblem(reply, refusal.problem);
      try {
        const offered = await options.capabilities.listPublishable();
        return reply
          .code(200)
          .type(HEADERS.contentType)
          .send({
            observedAt: options.clock.now(),
            capabilities: offered.map((c) => ({ capabilityId: c.capabilityId, mode: c.mode, version: c.version, state: c.state, validFrom: c.validFrom })),
          });
      } catch (error) {
        return sendProblem(reply, answerOf(error, correlationId, options));
      }
    },
  });

  app.route({
    method: inquiryRoute.method,
    url: inquiryRoute.path,
    config: { responses: operationalRouteResponses(INQUIRY_OPERATION) },
    // the Origin first, then the head of the admission: decided before the body is read, so neither the parser's size limit nor a
    // content type can answer for a request whose origin this route refuses
    onRequest: async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !allowed.has(origin)) return sendProblem(reply, originRejected(request.id));
      const early = admitHeaders({ headers: singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
      if (early !== null) return sendProblem(reply, early.problem);
      return undefined;
    },
    handler: async (request, reply) => {
      const correlationId = request.id as CorrelationId;
      const raw: Pick<RawRequest, "headers" | "repeatedHeaders" | "correlationId" | "body"> = {
        headers: singleValued(request.headers),
        repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders),
        correlationId,
        body: Buffer.isBuffer(request.body) ? request.body : null,
      };
      const admission = admitOperationalBody<InquiryBody>(inquiryRoute, raw, options.validator);
      if (admission.kind === "PROBLEM") return sendProblem(reply, admission.problem);
      try {
        const receipt = await receiveInquiry(
          { store: options.inquiries, clock: options.clock, ids: options.ids, hashKey: options.hashKey },
          admission.body,
          options.clientNetwork(request.ip),
        );
        return reply.code(201).type(HEADERS.contentType).send({ inquiryId: receipt.inquiryId, receivedAt: receipt.receivedAt });
      } catch (error) {
        return sendProblem(reply, answerOf(error, correlationId, options));
      }
    },
  });
}

/**
 * The public opt-out routes (B12 lane L-ACT; plan "Public opt-out", D-B12O-12/13/21, RFC 8058), the List-Unsubscribe URI of a sales message:
 *
 *   GET  /api/v1/public/outreach/opt-out/{token}   303 to the human page /unsubscribe/{token}; no body, no media type, writes nothing
 *   POST /api/v1/public/outreach/opt-out/{token}   the one-click body; 200 (never a redirect), 400 (media type or body), or 429 for a network's unknown-token flood
 *
 * Neither route reads a cookie, Authorization, Origin or Idempotency-Key. This module is the only caller of admitOneClickOptOut.
 */
import type { FastifyInstance } from "fastify";
import type { CorrelationId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { OptOutKey, OptOutStore, Problem } from "@kauro/application";
import { HEADERS, admitOneClickOptOut, internalProblem, operationalRouteResponses, optOutByToken, problemOf } from "@kauro/application";
import { sendProblem } from "../http.js";

export const OPT_OUT_GET_OPERATION = "getOutreachOptOut";
export const OPT_OUT_POST_OPERATION = "postOutreachOptOut";
const PATH = "/api/v1/public/outreach/opt-out/:token";

export interface OptOutRoutesOptions {
  /** Newest key first; every key verifies (rotation). */
  readonly keys: ReadonlyArray<OptOutKey>;
  readonly store: OptOutStore;
  readonly clientNetwork: (address: string | undefined) => string | null;
  readonly sink: (correlationId: string, error: unknown) => void;
}

const problemFor = (failure: DomainFailure, correlationId: string): Problem => problemOf(failure, correlationId);

export function registerOptOutRoutes(app: FastifyInstance, options: OptOutRoutesOptions): void {
  app.route({
    method: "GET",
    url: PATH,
    config: { responses: operationalRouteResponses(OPT_OUT_GET_OPERATION) },
    handler: async (request, reply) => {
      const token = (request.params as { token: string }).token;
      return reply.code(303).header("location", `/unsubscribe/${encodeURIComponent(token)}`).send();
    },
  });

  app.route({
    method: "POST",
    url: PATH,
    bodyLimit: 1024,
    config: { responses: operationalRouteResponses(OPT_OUT_POST_OPERATION) },
    handler: async (request, reply) => {
      const correlationId = request.id as CorrelationId;
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const contentType = request.headers["content-type"];
      const admitted = admitOneClickOptOut(typeof contentType === "string" ? contentType : undefined, body);
      if (admitted.kind === "CONTENT_TYPE_UNSUPPORTED") {
        return sendProblem(reply, problemFor(new DomainFailure("INVALID_REQUEST", "request refused: CONTENT_TYPE_UNSUPPORTED", { reason: "CONTENT_TYPE_UNSUPPORTED" }), correlationId));
      }
      if (admitted.kind === "SCHEMA_VIOLATION") {
        return sendProblem(reply, problemFor(new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field: "body", code: "FORMAT" }] }), correlationId));
      }
      try {
        const token = (request.params as { token: string }).token;
        const answer = await optOutByToken({ keys: options.keys, store: options.store }, token, options.clientNetwork(request.ip));
        if (answer.kind === "LIMITED") {
          return sendProblem(reply, problemFor(new DomainFailure("ADMISSION_LIMITED", "too many unknown opt-out tokens from this network", { reason: "INQUIRY_RATE_LIMITED", retryAfterSeconds: 60 }), correlationId));
        }
        return reply.code(200).type(HEADERS.contentType).send({ status: "RECEIVED" });
      } catch (error) {
        if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return sendProblem(reply, problemOf(error, correlationId));
        options.sink(correlationId, error);
        return sendProblem(reply, internalProblem(correlationId));
      }
    },
  });
}

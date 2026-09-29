/**
 * The two reply helpers every route of the api shares (server.ts, sessions.ts): the single-valued header view a request is
 * admitted from, and the problem reply with the headers every reply carries.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Problem } from "@kauro/application";
import { HEADERS, PRIVATE_CACHE_POLICY } from "@kauro/application";

/** Lowercased header names, one string value each (a repeated field is refused from the raw header list, never read here). */
export function singleValued(headers: FastifyRequest["headers"]): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = typeof v === "string" ? v : undefined;
  return out;
}

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  // the headers every reply carries are set here too: a framework error is answered outside the hooks that set them (N15)
  return reply
    .code(problem.status)
    .header(HEADERS.correlationId, problem.correlationId)
    .header(HEADERS.cacheControl, PRIVATE_CACHE_POLICY)
    .type(HEADERS.problemContentType)
    .send(problem);
}

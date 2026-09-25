/**
 * Liveness and readiness of the api process (14 "Monitoring and service health": liveness checks process health without
 * paid calls or customer files; readiness checks the minimum dependencies and the schema compatibility the service's role
 * needs; a database outage is visible without exposing credentials. 14 "Deployment and rollback": a candidate's schema
 * compatibility and readiness are verified before traffic shifts). Review finding R42.
 *
 * Both routes live outside /api/v1: they are the platform's probes, not product API, need no credential and never touch a
 * customer row. GET /livez answers from the process alone. GET /readyz reads the migration ledger over a verified runtime
 * connection (the pool's role check runs on first use of every connection) and compares it with the migrations this build
 * ships, by version and checksum: 200 when every shipped migration is recorded unchanged, 503 when the database is
 * unreachable, the schema is behind or drifted, or the process is draining. The answer names states, never an error text,
 * a host or a role; the cause of a NOT_READY answer is handed to the diagnostics sink by correlation id.
 *
 * The probes' declarations — operation ids, paths, summaries, authority and the closed schema of every reply — are operational
 * routes of @kauro/application (OPERATIONAL_ROUTES, api/response-schemas), the list the closed validator compiles, the send
 * guard checks replies against and the OpenAPI generator and checker document (review R23 and R42 connected): each probe
 * registers `operationalRouteResponses(<operationId>)` as its `config.responses`. HEALTH_ROUTES is that pair of routes.
 */
import type { FastifyInstance } from "fastify";
import type { JsonSchema, OperationalResponse, OperationalRoute } from "@kauro/application";
import { OPERATIONAL_ROUTES, operationalRouteResponses } from "@kauro/application";
import type { SchemaCompatibility } from "@kauro/persistence";

export { LIVENESS_RESPONSE_SCHEMA, READINESS_RESPONSE_SCHEMA } from "@kauro/application";

/** What the database side reports to readiness: the ledger comparison, or that it could not be read (with the cause). */
export type DatabaseReadiness =
  | { readonly database: "AVAILABLE"; readonly schema: SchemaCompatibility }
  | { readonly database: "UNAVAILABLE"; readonly codeVersion: number; readonly cause: unknown };

export interface LivenessResponse {
  readonly status: "LIVE";
}

export interface ReadinessResponse {
  readonly status: "READY" | "NOT_READY";
  readonly checks: {
    /** DRAINING once shutdown began: the load balancer must stop routing here before the process exits. */
    readonly process: "SERVING" | "DRAINING";
    readonly database: "AVAILABLE" | "UNAVAILABLE" | "NOT_CHECKED";
    readonly schema: "COMPATIBLE" | "BEHIND" | "DRIFTED" | "NOT_CHECKED";
  };
  /** The highest migration version this build ships, and the highest the database records (null when not read). */
  readonly schemaVersion: { readonly code: number; readonly database: number | null };
}

/** A closed JSON Schema 2020-12 object in the keyword vocabulary of @kauro/application's strict validator. */
export type ProbeSchema = JsonSchema;

/** One declared reply of a probe route. */
export type ProbeResponse = OperationalResponse;

/** A probe route: an operational route of the response contract. */
export type ProbeRoute = OperationalRoute;

const JSON_CONTENT_TYPE = "application/json";

/** The operation ids of the two probes, as OPERATIONAL_ROUTES declares them. */
export const HEALTH_OPERATION_IDS = Object.freeze(["getLiveness", "getReadiness"] as const);

function probeRoute(operationId: (typeof HEALTH_OPERATION_IDS)[number]): ProbeRoute {
  const route = OPERATIONAL_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`the operational route ${operationId} is not declared in OPERATIONAL_ROUTES of @kauro/application`);
  return route;
}

/** The probe routes, their operation ids and replies (the route inventory and the OpenAPI document read this). */
export const HEALTH_ROUTES: ReadonlyArray<ProbeRoute> = Object.freeze(HEALTH_OPERATION_IDS.map(probeRoute));

export const HEALTH_PATHS: ReadonlySet<string> = new Set(HEALTH_ROUTES.map((r) => r.path));

export interface HealthOptions {
  /** Reads the database side of readiness (composition: the ledger over a verified runtime connection, compared). */
  readonly readiness: () => Promise<DatabaseReadiness>;
  /** True once shutdown began (the server's preClose). */
  readonly draining: () => boolean;
  /** The highest migration version this build ships. */
  readonly codeSchemaVersion: number;
  /** Receives every NOT_READY answer with its correlation id and, when the database could not be read, the cause. */
  readonly onNotReady: (correlationId: string, response: ReadinessResponse, cause: unknown) => void;
}

/** Derives the readiness answer from the process state and the database report. */
export function readinessOf(draining: boolean, codeSchemaVersion: number, report: DatabaseReadiness | null): ReadinessResponse {
  if (draining || report === null) {
    return { status: "NOT_READY", checks: { process: "DRAINING", database: "NOT_CHECKED", schema: "NOT_CHECKED" }, schemaVersion: { code: codeSchemaVersion, database: null } };
  }
  if (report.database === "UNAVAILABLE") {
    return { status: "NOT_READY", checks: { process: "SERVING", database: "UNAVAILABLE", schema: "NOT_CHECKED" }, schemaVersion: { code: codeSchemaVersion, database: null } };
  }
  const schema = report.schema;
  return {
    status: schema.kind === "COMPATIBLE" ? "READY" : "NOT_READY",
    checks: { process: "SERVING", database: "AVAILABLE", schema: schema.kind },
    schemaVersion: { code: schema.codeVersion, database: schema.databaseVersion },
  };
}

/** Registers GET /livez and GET /readyz on `app` (outside /api/v1), each with the replies OPERATIONAL_ROUTES declares for it. */
export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  const liveness = probeRoute("getLiveness");
  const readiness = probeRoute("getReadiness");
  app.get(liveness.path, { config: { responses: operationalRouteResponses(liveness.operationId) } }, async (_request, reply) => {
    const body: LivenessResponse = { status: "LIVE" };
    return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  });
  app.get(readiness.path, { config: { responses: operationalRouteResponses(readiness.operationId) } }, async (request, reply) => {
    // a draining process reports it without opening a database connection
    const report = options.draining() ? null : await options.readiness();
    const body = readinessOf(options.draining(), options.codeSchemaVersion, report);
    if (body.status === "NOT_READY") options.onNotReady(request.id, body, report !== null && report.database === "UNAVAILABLE" ? report.cause : undefined);
    return reply.code(body.status === "READY" ? 200 : 503).type(JSON_CONTENT_TYPE).send(body);
  });
}

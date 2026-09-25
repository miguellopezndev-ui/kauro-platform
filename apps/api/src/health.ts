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
 * HEALTH_ROUTES and the response schemas are exported for the route inventory and the OpenAPI document. Each entry has the
 * shape of an operational route of @kauro/application's response contract (operationId, method, path, summary, authority,
 * and the replies by status with a description, a content type and a closed schema written in the strict validator's
 * vocabulary, so the same validator compiles it): connecting the probes to the OpenAPI checker is moving these entries into
 * the application's list of operational routes.
 */
import type { FastifyInstance } from "fastify";
import type { SchemaCompatibility } from "@kauro/persistence";

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
export type ProbeSchema = Readonly<Record<string, unknown>>;

export const LIVENESS_RESPONSE_SCHEMA: ProbeSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: ["LIVE"] } },
});

export const READINESS_RESPONSE_SCHEMA: ProbeSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "checks", "schemaVersion"],
  properties: {
    status: { type: "string", enum: ["READY", "NOT_READY"] },
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["process", "database", "schema"],
      properties: {
        process: { type: "string", enum: ["SERVING", "DRAINING"] },
        database: { type: "string", enum: ["AVAILABLE", "UNAVAILABLE", "NOT_CHECKED"] },
        schema: { type: "string", enum: ["COMPATIBLE", "BEHIND", "DRIFTED", "NOT_CHECKED"] },
      },
    },
    schemaVersion: {
      type: "object",
      additionalProperties: false,
      required: ["code", "database"],
      properties: {
        code: { type: "integer", minimum: 0 },
        database: { type: ["integer", "null"], minimum: 0 },
      },
    },
  },
});

/** One declared reply of a probe route. */
export interface ProbeResponse {
  readonly description: string;
  readonly contentType: string;
  readonly schema: ProbeSchema;
}

/** A probe route: what the route inventory and the OpenAPI document need (an operational route of the response contract). */
export interface ProbeRoute {
  readonly operationId: "getLiveness" | "getReadiness";
  readonly method: "GET";
  readonly path: "/livez" | "/readyz";
  readonly summary: string;
  /** The manual sections that require the route. */
  readonly authority: string;
  /** Declared replies by HTTP status. */
  readonly responses: Readonly<Record<string, ProbeResponse>>;
}

const JSON_CONTENT_TYPE = "application/json";

/** The probe routes, their operation ids and replies (the route inventory and the OpenAPI document read this). */
export const HEALTH_ROUTES: ReadonlyArray<ProbeRoute> = Object.freeze([
  Object.freeze({
    operationId: "getLiveness",
    method: "GET",
    path: "/livez",
    summary: "Liveness of the api process",
    authority: '14 "Monitoring and service health"',
    responses: Object.freeze({
      "200": Object.freeze({ description: "The process is live; nothing else is checked.", contentType: JSON_CONTENT_TYPE, schema: LIVENESS_RESPONSE_SCHEMA }),
    }),
  }),
  Object.freeze({
    operationId: "getReadiness",
    method: "GET",
    path: "/readyz",
    summary: "Readiness: a verified database connection and a schema compatible with this build",
    authority: '14 "Monitoring and service health"; 14 "Deployment and rollback"',
    responses: Object.freeze({
      "200": Object.freeze({ description: "Ready: the database is reachable and records every migration this build ships, unchanged.", contentType: JSON_CONTENT_TYPE, schema: READINESS_RESPONSE_SCHEMA }),
      "503": Object.freeze({ description: "Not ready: the process is draining, the database is unreachable, or its schema is behind or drifted.", contentType: JSON_CONTENT_TYPE, schema: READINESS_RESPONSE_SCHEMA }),
    }),
  }),
]);

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

/** Registers GET /livez and GET /readyz on `app` (outside /api/v1). */
export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  app.get("/livez", async (_request, reply) => {
    const body: LivenessResponse = { status: "LIVE" };
    return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  });
  app.get("/readyz", async (request, reply) => {
    // a draining process reports it without opening a database connection
    const report = options.draining() ? null : await options.readiness();
    const body = readinessOf(options.draining(), options.codeSchemaVersion, report);
    if (body.status === "NOT_READY") options.onNotReady(request.id, body, report !== null && report.database === "UNAVAILABLE" ? report.cause : undefined);
    return reply.code(body.status === "READY" ? 200 : 503).type(JSON_CONTENT_TYPE).send(body);
  });
}

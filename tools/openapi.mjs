// OpenAPI 3.1 generator and checker of the Kauro API (10 "Version and validation": "OpenAPI is generated from the owning
// contract registry and checked against actual routes. The build fails on undocumented public routes, missing operation IDs,
// incompatible response schemas or a DTO that exposes a forbidden field. TypeScript types alone are insufficient runtime
// validation"; 10 "Contract tests and compatibility": the release includes a route/schema inventory).
//
//   node tools/openapi.mjs generate   writes apps/api/openapi.json
//   node tools/openapi.mjs check      exits 1, listing every failure, when the committed document is not the generated one,
//                                     an operation has no (or a duplicate) operationId, a registered route is undocumented,
//                                     a documented route is not registered, a route's declared replies differ from the
//                                     documented response schemas, a route's outcome catalogue differs from the problems it
//                                     documents per status (x-kauro-outcomes), or a response schema declares a forbidden member,
//                                     or a planned operation (x-kauro-planned) is registered as a route, is also documented as
//                                     served, repeats an operationId or declares a forbidden member
//
// Sources (nothing is written by hand): the served commands — B06's seven and B07's six — come from the provenance-verified
// registry commands.json (path, method, operationId = registry name, role, idempotency, cases, precondition/effect/failure); their
// request schemas, the response views (derived from the registry contract bundle), the envelopes, the Problem document, the reads
// (READ_ROUTES: the manual-10 reads of re-check finding N16, B07's source reads and B08's GetJob and GetAudit), the selection manifest
// and the decision artifact intake (INTAKE_ROUTES: B07 D-SEL-2, B08 D8-CMA-7) and the operational routes come from @kauro/application — the very objects the api's
// validator compiles and its send guard validates with. The routes
// are the ones the composition root actually registers: tools/openapi.mjs builds the api with `assembleApi` over the real pg
// unit-of-work adapter and reads its route inventory. Route registration needs no database: the pool is created lazily and
// never connected, and the check asserts that it opened no connection.
//
// Planned operations (package B07, docs/design/B07-upload-source-lifecycle.md §9.5; finding B07-F13; package B09,
// docs/design/B09-payments-fiscal.md §10): a route specified with its request schema, closed response schemas and outcome
// catalogue before its handler exists is generated from the same application contracts into the root member "x-kauro-planned"
// (keyed "METHOD path"), never into "paths": the check proves no planned route is registered (a registered route must be
// documented under "paths") or also served, and a specified route missing from the document fails the generated-document
// comparison. One copy of the mechanism serves both packages (B07 design §17 item 12). Mandate B07-COMMANDS served every B07
// route, so they moved into "paths" and B07 plans nothing any more. Package B09's payment routes name their served state in the
// application's served lists (COMMERCE_SERVED_COMMAND_IDS, COMMERCE_SERVED_READ_IDS; decisions D-REQ-B7, D-INT2-B1): the same
// generated operation moves out of the planned list into "paths", where it is checked against the registered route like every
// served one — implementation mandate M4 serves the request side (CMD028, CMD029, CMD031, CMD032 and the four reads), M3 the
// payment service's side (CMD030, CMD033, CMD034); after the stage-2 integration every B09 operation is served.
//
// Requires the workspace to be built (pnpm run build); the root "verify" script runs it after the build and the tests.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOCUMENT_PATH = join(root, "apps", "api", "openapi.json");
const COMPONENTS = "#/components/schemas/";

function load(rel) {
  return import(pathToFileURL(join(root, rel)).href);
}

/** The built modules and the registry the document is generated from. */
export async function loadSources() {
  const [application, contracts, domain] = await Promise.all([
    load("packages/application/dist/src/index.js"),
    load("packages/contracts/dist/src/index.js"),
    load("packages/domain/dist/src/index.js"),
  ]);
  const bundle = JSON.parse(readFileSync(join(root, "packages", "contracts", "dist", "src", "generated", "schemas.json"), "utf8"));
  return {
    application,
    domain,
    bundle,
    registryCommands: contracts.registryJson("commands.json"),
    provenance: contracts.provenance(),
    operationalRoutes: application.OPERATIONAL_ROUTES,
    // amendment A2: the legacy brand token, as the R2 digest-domain aliases name it (never spelled out here)
    legacyBrands: [...new Set(Object.keys(contracts.R2_DOMAIN_ALIASES).map((alias) => alias.split("_")[0]))],
  };
}

// --- JSON Schema -> OpenAPI 3.1 components -------------------------------------------------------------------------------

/** A validator schema as an OpenAPI component: no $schema/$id (the document's dialect applies), bundle refs to components. */
export function toComponent(schema, schemaId) {
  const convert = (s) => {
    if (Array.isArray(s)) return s.map(convert);
    if (typeof s !== "object" || s === null) return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "$schema" || k === "$id") continue;
      if (k === "$ref") {
        const m = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]*)$/.exec(v);
        if (!m) throw new Error(`unsupported $ref ${v} in ${schemaId}`);
        out[k] = COMPONENTS + m[1];
      } else out[k] = convert(v);
    }
    return out;
  };
  const component = convert(schema);
  return schemaId === undefined ? component : { ...component, "x-kauro-schema-id": schemaId };
}

function refsOf(schema, into = new Set()) {
  if (Array.isArray(schema)) schema.forEach((s) => refsOf(s, into));
  else if (typeof schema === "object" && schema !== null) {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith(COMPONENTS)) into.add(v.slice(COMPONENTS.length));
      else refsOf(v, into);
    }
  }
  return into;
}

/** Every schema the validator compiles for replies and requests, by id, with the definitions they reference. */
export function runtimeSchemas(sources) {
  const { application, bundle, operationalRoutes } = sources;
  // the served replies of every route, B06's and B07's alike (one build: the views, the envelopes, the intake's STORED envelope)
  const responses = application.buildResponseSchemas(bundle, operationalRoutes);
  // package B09: the planned payment routes' closed schemas, derived under the same rules (they never shadow a served one)
  const commerce = application.buildCommerceResponseSchemas(bundle);
  for (const id of Object.keys(commerce.roots)) if (id in responses.roots) throw new Error(`the B09 schema ${id} collides with a served one`);
  for (const name of Object.keys(commerce.defs)) if (name in responses.defs) throw new Error(`the B09 view ${name} collides with a served one`);
  const byId = { ...responses.roots, ...commerce.roots, Problem: application.PROBLEM_SCHEMA };
  for (const [command, schema] of Object.entries(application.REQUEST_SCHEMAS)) byId[application.REQUEST_SCHEMA_PREFIX + command] = schema;
  for (const [command, schema] of Object.entries(application.SOURCE_REQUEST_SCHEMAS)) {
    if (application.REQUEST_SCHEMA_PREFIX + command in byId) throw new Error(`the B07 request schema of ${command} collides with another one`);
    byId[application.REQUEST_SCHEMA_PREFIX + command] = schema;
  }
  byId[application.SELECTION_MANIFEST_SCHEMA_ID] = application.SELECTION_MANIFEST_SCHEMA;
  byId[application.DECISION_ARTIFACT_SCHEMA_ID] = application.DECISION_ARTIFACT_SCHEMA;
  for (const [command, schema] of Object.entries(application.EXECUTION_REQUEST_SCHEMAS)) {
    if (application.REQUEST_SCHEMA_PREFIX + command in byId) throw new Error(`the B08 request schema of ${command} collides with another one`);
    byId[application.REQUEST_SCHEMA_PREFIX + command] = schema;
  }
  for (const [command, schema] of Object.entries(application.AUDIT_REQUEST_SCHEMAS)) {
    if (application.REQUEST_SCHEMA_PREFIX + command in byId) throw new Error(`the B08 audit request schema of ${command} collides with another one`);
    byId[application.REQUEST_SCHEMA_PREFIX + command] = schema;
  }
  for (const [command, schema] of Object.entries(application.COMMERCE_REQUEST_SCHEMAS)) {
    if (application.REQUEST_SCHEMA_PREFIX + command in byId) throw new Error(`the B09 request schema of ${command} collides with a served one`);
    byId[application.REQUEST_SCHEMA_PREFIX + command] = schema;
  }
  for (const [id, schema] of Object.entries(application.operationalRequestSchemas(operationalRoutes))) {
    if (id in byId) throw new Error(`the operational request schema ${id} collides with another one`);
    byId[id] = schema;
  }
  // package B10: the commercial commands' closed schemas, derived under the same rules over the earlier packages' views (a served route's
  // components are generated below; the others stay out of the document until their command lane serves them)
  const commercial = application.buildCommercialResponseSchemas(bundle, { ...responses.defs, ...commerce.defs });
  for (const id of Object.keys(commercial.roots)) if (id in byId) throw new Error(`the B10 schema ${id} collides with an earlier package's`);
  for (const name of Object.keys(commercial.defs)) if (name in responses.defs || name in commerce.defs) throw new Error(`the B10 view ${name} collides with an earlier package's`);
  Object.assign(byId, commercial.roots);
  for (const [command, schema] of Object.entries(application.COMMERCIAL_REQUEST_SCHEMAS)) {
    if (application.REQUEST_SCHEMA_PREFIX + command in byId) throw new Error(`the B10 request schema of ${command} collides with an earlier one`);
    byId[application.REQUEST_SCHEMA_PREFIX + command] = schema;
  }
  const defs = { ...bundle.$defs, ...responses.defs, ...commerce.defs, ...commercial.defs };
  return { byId, defs };
}

// --- generation ----------------------------------------------------------------------------------------------------------

function pathParameters(path) {
  return [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
}

/** A catalogue as documented problem responses: [status, entries] in ascending status order, each entry a plain object. */
export function problemResponsesOf(application, outcomes) {
  return application.outcomesByStatus(outcomes).map(([status, entries]) => [
    String(status),
    entries.map((e) => ({ code: e.code, reason: e.reason, ...(e.fieldCodes !== undefined ? { fieldCodes: [...e.fieldCodes] } : {}), ...(e.current !== undefined ? { current: e.current } : {}), layer: e.layer, meaning: e.meaning })),
  ]);
}

/** Generates the OpenAPI 3.1 document. Deterministic: the same sources give the same bytes. */
export function generateOpenApi(sources) {
  const { application, domain, registryCommands, provenance, operationalRoutes } = sources;
  const { byId, defs } = runtimeSchemas(sources);
  const ID = { type: "string", pattern: application.RESPONSE_FIELD_VOCABULARY.UUID_PATTERN };
  const components = { schemas: {}, parameters: {}, headers: {}, securitySchemes: {} };
  const addComponent = (name, schema, schemaId) => {
    if (name in components.schemas) throw new Error(`component ${name} is generated twice`);
    components.schemas[name] = toComponent(schema, schemaId);
  };

  components.parameters.IdempotencyKey = {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    description: "Required on every command (10 \"Idempotency contract\"); a retry after a lost response reuses it.",
    schema: { type: "string", pattern: domain.IDEMPOTENCY_KEY.source },
  };
  components.parameters.AgencySelector = {
    name: "X-Kauro-Agency",
    in: "header",
    required: true,
    description: "The active agency context of a route whose path carries no agencyId (design D-SCOPE-1): a selector, never authority.",
    schema: ID,
  };
  components.parameters.CorrelationId = {
    name: "X-Correlation-Id",
    in: "header",
    required: false,
    description:
      "Opaque correlation id (10 \"Request envelope\"): adopted when it is an id of this shape; any other value is ignored — never refused, never echoed — and the server mints one, as when it is absent (review decision E-CORR-1). Every reply carries the id the request was handled under.",
    schema: { type: "string", pattern: application.REQUEST_LIMITS.correlationIdPattern.source },
  };
  components.parameters.InquiryOrigin = {
    name: "Origin",
    in: "header",
    required: true,
    description:
      "The exact origin of the public site or of the application as a browser writes it (B11 D-PUB-2, D-AUTH-5): compared as a whole string before the body is read; an absent header or any other origin is NOT_AUTHORIZED ORIGIN_REJECTED. The api never answers with a cross-origin header.",
    schema: { type: "string", pattern: "^https?://[^/?#\\s]+$" },
  };
  components.headers.CorrelationId = { description: "The correlation id of the request, on every reply.", schema: { type: "string", minLength: 1, maxLength: 128 } };
  components.parameters.PageLimit = {
    name: "limit",
    in: "query",
    required: false,
    description: `Page size (10 "Pagination, search and exports"; the R2 policy's api.pageDefault ${application.REQUEST_LIMITS.pageDefault} and api.pageMaximum ${application.REQUEST_LIMITS.pageMaximum}).`,
    schema: { type: "integer", minimum: 1, maximum: application.REQUEST_LIMITS.pageMaximum, default: application.REQUEST_LIMITS.pageDefault },
  };
  components.parameters.PageCursor = {
    name: "cursor",
    in: "query",
    required: false,
    description: "The nextCursor of the previous page: opaque, integrity-protected and bound to the caller, the agency, the list, its filter and its order (10 \"Pagination, search and exports\"; R2-060). Any other cursor is CURSOR_INVALID.",
    schema: { type: "string", pattern: application.CURSOR_PATTERN, maxLength: 600 },
  };
  components.headers.CacheControl = {
    description: "Every reply is private (08 \"Browser, API and cache isolation\": private responses use an explicit no-shared-cache policy): it is never stored by a shared or a private cache.",
    schema: { type: "string", const: application.PRIVATE_CACHE_POLICY },
  };
  const REPLY_HEADERS = { "X-Correlation-Id": { $ref: "#/components/headers/CorrelationId" }, "Cache-Control": { $ref: "#/components/headers/CacheControl" } };
  components.securitySchemes.bearerAuth = { type: "http", scheme: "bearer", description: "Authenticated subject (08 \"Authentication and assurance\")." };
  components.securitySchemes.serviceAuth = {
    type: "http",
    scheme: "bearer",
    description:
      "A verified service identity: issuer, audience, expected identity and environment (COMMAND_CATALOGUE \"Service commands require a verified service identity and audience, with scope derived from the stored operation\"; package B09 D-AUTHZ-B3).",
  };
  components.securitySchemes.sessionCookie = {
    type: "apiKey",
    in: "cookie",
    name: application.SESSION_COOKIE,
    description:
      "The browser session (B11 design D-AUTH-1, D-AUTH-5): Secure; HttpOnly; SameSite=Lax. An unsafe request it authenticates needs the exact application Origin, a same-origin Sec-Fetch-Site and the session's X-Kauro-CSRF token; a cookie beside an Authorization header is AMBIGUOUS_CREDENTIALS.",
  };
  components.parameters.CsrfToken = {
    name: "X-Kauro-CSRF",
    in: "header",
    required: false,
    description: "The session's CSRF token (SessionView.csrfToken): required on an unsafe request the session cookie authenticates (B11 D-AUTH-5); refused as CSRF_TOKEN_INVALID otherwise.",
    schema: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  };
  components.headers.SetSessionCookie = { description: "The session cookie (__Host-kauro_session): set by sign-in, cleared (Max-Age=0) by logout.", schema: { type: "string" } };
  components.headers.ClearSiteData = { description: "The logout clears the site's cache, cookies and storage where the browser allows it (08 \"Browser, API and cache isolation\").", schema: { type: "string", const: application.CLEAR_SITE_DATA } };

  const problemResponse = {
    description: "Problem document (10 \"Responses and safe errors\"): every status >= 400 the operation does not declare otherwise.",
    headers: REPLY_HEADERS,
    content: { [application.PROBLEM_RESPONSE.contentType]: { schema: { $ref: `${COMPONENTS}Problem` } } },
  };
  // a route with an outcome catalogue (re-check finding N13) documents each problem status with the closed list of the
  // outcomes that answer it; the send guard refuses any other problem on that route
  const problemResponses = (outcomes) => Object.fromEntries(problemResponsesOf(application, outcomes).map(([status, entries]) => [
    status,
    {
      description: `Problem (10 "Responses and safe errors"): the ${entries.length === 1 ? "outcome" : `${entries.length} outcomes`} of this operation answered ${status}, listed in x-kauro-outcomes; frontends branch on code and reason, never on the title.`,
      headers: REPLY_HEADERS,
      content: { [application.PROBLEM_RESPONSE.contentType]: { schema: { $ref: `${COMPONENTS}Problem` } } },
      "x-kauro-outcomes": entries,
    },
  ]));

  const paths = {};
  const served = new Set(application.SERVED_COMMAND_IDS);
  // the served commands' specs: B06's seven, B07's six (mandate B07-COMMANDS), B08's two execution commands (mandate B08-COMMANDS-EXECUTION) and its four audit commands (mandate B08-COMMANDS-AUDIT), and B11's CMD044 (mandate W4)
  const specs = { ...application.B06_COMMANDS, ...application.B07_COMMANDS, ...application.EXECUTION_COMMANDS, ...application.AUDIT_COMMANDS, ...application.SUPPORT_COMMANDS };
  for (const command of registryCommands) {
    if (!served.has(command.id)) continue;
    const spec = specs[command.id];
    if (!spec) throw new Error(`${command.id} has a declared response but no command spec`);
    if (spec.method !== command.method || spec.path !== command.path || spec.name !== command.name) {
      throw new Error(`${command.id}: the application spec (${spec.method} ${spec.path} ${spec.name}) differs from the registry (${command.method} ${command.path} ${command.name})`);
    }
    const contract = application.commandRouteResponses(command.id, command.name);
    const requestId = application.REQUEST_SCHEMA_PREFIX + command.id;
    addComponent(`${command.name}Request`, byId[requestId], requestId);
    const responses = {};
    for (const [status, declared] of Object.entries(contract.declared)) {
      if (declared.schemaId === application.ACCEPTED_RESPONSE_SCHEMA_ID) {
        // an ACCEPTED command (B07 CompleteUpload, D-RUN-1; B08 ExecuteProject, StartAudit and ValidatePlan, D8-API-1): the shared envelope, added once below
        const accepted = {
          CMD036: "ACCEPTED: the job was queued and runs asynchronously — the operation (the processing job), its state, the status path of GetJob and the polling guidance (package B08 D8-API-1)",
          CMD020: "ACCEPTED: the audit was queued and runs asynchronously — the operation (the audit), its state, the status path of GetAudit and the polling guidance (package B08 D8-API-1)",
          CMD024: "ACCEPTED: the plan's validation was requested and runs asynchronously — the operation (the plan), its state VALIDATING, the plan's status path and the polling guidance (package B08 D8-API-1, D8-CMA-4)",
        };
        responses[status] = {
          description: accepted[command.id] ?? "ACCEPTED: completion remains asynchronous — the verification operation (the upload), its state, the status path and the polling guidance (package B07 D-RUN-1)",
          headers: REPLY_HEADERS,
          content: { [declared.contentType]: { schema: { $ref: `${COMPONENTS}AcceptedResponse` } } },
        };
        continue;
      }
      addComponent(`${command.name}Completed`, byId[declared.schemaId], declared.schemaId);
      responses[status] = {
        description: `COMPLETED: ${command.effect}`,
        headers: REPLY_HEADERS,
        content: { [declared.contentType]: { schema: { $ref: `${COMPONENTS}${command.name}Completed` } } },
      };
    }
    if (contract.outcomes === null) throw new Error(`${command.id} has no outcome catalogue`);
    Object.assign(responses, problemResponses(contract.outcomes));
    const parameters = [
      ...pathParameters(command.path).map((name) => ({ name, in: "path", required: true, description: "Path id, resolved with server-owned tenant scope (reference/COMMAND_CATALOGUE).", schema: ID })),
      { $ref: "#/components/parameters/IdempotencyKey" },
      ...(spec.scope === "AGENCY_HEADER" ? [{ $ref: "#/components/parameters/AgencySelector" }] : []),
      { $ref: "#/components/parameters/CorrelationId" },
    ];
    paths[command.path] = {
      ...(paths[command.path] ?? {}),
      [command.method.toLowerCase()]: {
        operationId: command.name,
        summary: `${command.id} ${command.name}`,
        description: `Precondition: ${command.precondition}\n\nEffect: ${command.effect}\n\nFailure: ${command.failure}`,
        "x-kauro-command": command.id,
        "x-kauro-role": command.role,
        "x-kauro-idempotency": command.idempotency,
        "x-kauro-gate": command.gate,
        "x-kauro-cases": command.testIds ?? [],
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        parameters: [...parameters, { $ref: "#/components/parameters/CsrfToken" }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: `${COMPONENTS}${command.name}Request` } } } },
        responses,
      },
    };
  }
  const missing = [...served].filter((id) => !registryCommands.some((c) => c.id === id));
  if (missing.length > 0) throw new Error(`served commands absent from the registry: ${missing.join(", ")}`);

  // the reads — the manual-10 reads (N16) and B07's source reads: not registry commands; their paths, operation ids and authority
  // come from READ_ROUTES
  for (const spec of Object.values(application.READ_ROUTES)) {
    const contract = application.readRouteResponses(spec.operationId);
    const schemaId = application.readResponseSchemaId(spec.operationId);
    addComponent(`${spec.operationId}Reply`, byId[schemaId], schemaId);
    const parameters = [
      ...pathParameters(spec.path).map((name) => ({ name, in: "path", required: true, description: "Path id, resolved with server-owned tenant scope.", schema: ID })),
      ...(spec.scope === "AGENCY_HEADER" ? [{ $ref: "#/components/parameters/AgencySelector" }] : []),
      ...(spec.paginated ? [{ $ref: "#/components/parameters/PageLimit" }, { $ref: "#/components/parameters/PageCursor" }] : []),
      { $ref: "#/components/parameters/CorrelationId" },
    ];
    paths[spec.path] = {
      ...(paths[spec.path] ?? {}),
      get: {
        operationId: spec.operationId,
        summary: spec.summary,
        description: `Authority: ${spec.authority}`,
        "x-kauro-read": true,
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        parameters,
        responses: {
          200: {
            description: `READ: ${spec.summary}`,
            headers: REPLY_HEADERS,
            content: { [contract.declared["200"].contentType]: { schema: { $ref: `${COMPONENTS}${spec.operationId}Reply` } } },
          },
          ...problemResponses(contract.outcomes),
        },
      },
    };
  }

  // the document intakes (B07 D-SEL-2, B08 D8-CMA-7): the selection manifest and the decision artifact, each stored once per content —
  // 201 stored, 200 the same document again
  addComponent("SelectionManifestDocument", byId[application.SELECTION_MANIFEST_SCHEMA_ID], application.SELECTION_MANIFEST_SCHEMA_ID);
  addComponent("DecisionArtifactDocument", byId[application.DECISION_ARTIFACT_SCHEMA_ID], application.DECISION_ARTIFACT_SCHEMA_ID);
  const intakeDocuments = { [application.SELECTION_MANIFEST_SCHEMA_ID]: "SelectionManifestDocument", [application.DECISION_ARTIFACT_SCHEMA_ID]: "DecisionArtifactDocument" };
  for (const spec of Object.values(application.INTAKE_ROUTES)) {
    const documentComponent = intakeDocuments[spec.schemaId];
    if (documentComponent === undefined) throw new Error(`${spec.operationId} admits a document schema this generator does not document`);
    const contract = application.intakeRouteResponses(spec.operationId);
    const schemaId = application.intakeResponseSchemaId(spec.operationId);
    addComponent(`${spec.operationId}Reply`, byId[schemaId], schemaId);
    const reply = (description) => ({ description, headers: REPLY_HEADERS, content: { [contract.declared["201"].contentType]: { schema: { $ref: `${COMPONENTS}${spec.operationId}Reply` } } } });
    paths[spec.path] = {
      ...(paths[spec.path] ?? {}),
      [spec.method.toLowerCase()]: {
        operationId: spec.operationId,
        summary: spec.summary,
        description: `Authority: ${spec.authority}`,
        "x-kauro-intake": true,
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        parameters: [
          ...pathParameters(spec.path).map((name) => ({ name, in: "path", required: true, description: "Path id, resolved with server-owned tenant scope.", schema: ID })),
          ...(spec.scope === "AGENCY_HEADER" ? [{ $ref: "#/components/parameters/AgencySelector" }] : []),
          { $ref: "#/components/parameters/CorrelationId" },
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: `${COMPONENTS}${documentComponent}` } } } },
        responses: {
          200: reply("STORED: the same document was already stored for this subject (created false; content-idempotent, D-SEL-2, D8-CMA-7)"),
          201: reply("STORED: the document is stored (created true)"),
          ...problemResponses(contract.outcomes),
        },
      },
    };
  }

  // package B09: the payment routes (see the header), generated from the application contracts; a served one under "paths" with
  // exactly the replies its route declares, a planned one under "x-kauro-planned" keyed "METHOD path"
  const planned = {};
  const serve = (method, path, operation) => {
    paths[path] = { ...(paths[path] ?? {}), [method.toLowerCase()]: operation };
  };
  const PROVIDER_LABEL = { type: "string", pattern: "^[a-z][a-z0-9_-]{1,63}$" };
  for (const spec of Object.values(application.COMMERCE_COMMANDS)) {
    const command = registryCommands.find((c) => c.id === spec.id);
    if (!command) throw new Error(`${spec.id} is planned but absent from the registry`);
    if (spec.method !== command.method || spec.path !== command.path || spec.name !== command.name) {
      throw new Error(`${spec.id}: the application spec (${spec.method} ${spec.path} ${spec.name}) differs from the registry (${command.method} ${command.path} ${command.name})`);
    }
    if (served.has(spec.id)) continue;
    const webhook = spec.idempotencyStore === "PROVIDER_INBOX";
    const requestId = application.REQUEST_SCHEMA_PREFIX + spec.id;
    addComponent(`${spec.name}Request`, byId[requestId], requestId);
    const reply = application.COMMERCE_COMMAND_RESPONSES[spec.id];
    const replyId = application.commerceCommandResponseSchemaId(spec.id);
    addComponent(`${spec.name}Completed`, byId[replyId], replyId);
    const responses = {
      [String(reply.status)]: {
        description: `COMPLETED: ${command.effect}`,
        headers: REPLY_HEADERS,
        content: { "application/json": { schema: { $ref: `${COMPONENTS}${spec.name}Completed` } } },
      },
    };
    if (reply.accepted) {
      responses["202"] = {
        description: "ACCEPTED: the provider effect was dispatched and its outcome is not known yet; the durable operation, its state and the polling guidance (package B09 D-PROTO-B2)",
        headers: REPLY_HEADERS,
        content: { "application/json": { schema: { $ref: `${COMPONENTS}AcceptedResponse` } } },
      };
    }
    Object.assign(responses, problemResponses(application.COMMERCE_COMMAND_OUTCOMES[spec.id]));
    const operation = {
      operationId: spec.name,
      summary: `${spec.id} ${spec.name}`,
      description: `Precondition: ${command.precondition}\n\nEffect: ${command.effect}\n\nFailure: ${command.failure}`,
      "x-kauro-command": spec.id,
      "x-kauro-role": spec.role,
      "x-kauro-principal": spec.principal,
      "x-kauro-runtime-role": spec.runtimeRole,
      "x-kauro-settle-runtime-role": spec.settleRuntimeRole,
      "x-kauro-scope": spec.scope,
      "x-kauro-idempotency": webhook ? "PROVIDER_INBOX" : command.idempotency,
      "x-kauro-step-up": spec.stepUp,
      "x-kauro-external-effect": spec.externalEffect,
      "x-kauro-gate": command.gate,
      "x-kauro-cases": command.testIds ?? [],
      "x-kauro-package": "B09",
      // a person's payment command is authenticated like any command: a bearer token or the browser session (B11 D-AUTH-5)
      security: webhook ? [] : spec.principal === "PAYMENT_SERVICE" ? [{ serviceAuth: [] }] : [{ bearerAuth: [] }, { sessionCookie: [] }],
      parameters: [
        ...pathParameters(spec.path).map((name) =>
          name === "provider"
            ? { name, in: "path", required: true, description: "The provider label; an unconfigured provider is PROVIDER_UNKNOWN.", schema: PROVIDER_LABEL }
            : { name, in: "path", required: true, description: "Path id, resolved with server-owned scope (the agency selector, or the stored operation's scope index).", schema: ID },
        ),
        ...(webhook ? [] : [{ $ref: "#/components/parameters/IdempotencyKey" }]),
        ...(spec.scope === "AGENCY_HEADER" ? [{ $ref: "#/components/parameters/AgencySelector" }] : []),
        { $ref: "#/components/parameters/CorrelationId" },
        ...(webhook || spec.principal === "PAYMENT_SERVICE" ? [] : [{ $ref: "#/components/parameters/CsrfToken" }]),
      ],
      requestBody: webhook
        ? {
            required: true,
            description:
              "The provider's raw event: authenticated by the provider-specific signature over the exact bytes, freshness and environment, bounded by the provider's body limit; never validated as a Kauro schema. The ingress records it and builds the normalized inbox command (x-kauro-normalized-command).",
            content: { "application/json": { schema: { type: "object" } } },
          }
        : { required: true, content: { "application/json": { schema: { $ref: `${COMPONENTS}${spec.name}Request` } } } },
      ...(webhook ? { "x-kauro-normalized-command": { $ref: `${COMPONENTS}${spec.name}Request` } } : {}),
      responses,
    };
    if (application.isServedCommerceCommand(spec.id)) {
      // the route's own contract: the statuses it declares are the ones documented, nothing more (the check compares the schemas)
      const contract = application.commerceCommandRouteResponses(spec.id);
      const documented = Object.keys(responses).filter((status) => Number(status) < 400);
      if (!isDeepStrictEqual(documented.sort(), Object.keys(contract.declared).sort())) throw new Error(`${spec.id}: the documented replies ${documented} differ from the route's ${Object.keys(contract.declared)}`);
      serve(spec.method, spec.path, operation);
    } else planned[`${spec.method} ${spec.path}`] = operation;
  }
  for (const [operationId, spec] of Object.entries(application.COMMERCE_READ_ROUTES)) {
    const schemaId = application.commerceReadResponseSchemaId(operationId);
    addComponent(`${operationId}Reply`, byId[schemaId], schemaId);
    const operation = {
      operationId,
      summary: spec.summary,
      description: `Authority: ${spec.authority}`,
      "x-kauro-read": true,
      "x-kauro-role": spec.role,
      "x-kauro-scope": spec.scope,
      "x-kauro-package": "B09",
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      parameters: [
        ...pathParameters(spec.path).map((name) => ({ name, in: "path", required: true, description: "Path id, resolved with server-owned scope.", schema: ID })),
        ...(spec.scope === "AGENCY_HEADER" ? [{ $ref: "#/components/parameters/AgencySelector" }] : []),
        { $ref: "#/components/parameters/CorrelationId" },
      ],
      responses: {
        200: { description: `READ: ${spec.summary}`, headers: REPLY_HEADERS, content: { "application/json": { schema: { $ref: `${COMPONENTS}${operationId}Reply` } } } },
        ...problemResponses(application.COMMERCE_READ_OUTCOMES[operationId]),
      },
    };
    if (application.isServedCommerceRead(operationId)) serve("GET", spec.path, operation);
    else planned[`GET ${spec.path}`] = operation;
  }

  // package B10: the served commercial commands (docs/design/B10-commercial-domain.md §13; COMMERCIAL_SERVED_COMMAND_IDS), generated from the
  // application contracts exactly as the payment routes are; a command no lane serves yet is not documented
  for (const spec of Object.values(application.COMMERCIAL_COMMANDS)) {
    if (!application.isServedCommercialCommand(spec.id)) continue;
    const command = registryCommands.find((c) => c.id === spec.id);
    if (!command) throw new Error(`${spec.id} is served but absent from the registry`);
    if (spec.method !== command.method || spec.path !== command.path || spec.name !== command.name) {
      throw new Error(`${spec.id}: the application spec (${spec.method} ${spec.path} ${spec.name}) differs from the registry (${command.method} ${command.path} ${command.name})`);
    }
    const requestId = application.REQUEST_SCHEMA_PREFIX + spec.id;
    addComponent(`${spec.name}Request`, byId[requestId], requestId);
    const reply = application.COMMERCIAL_COMMAND_RESPONSES[spec.id];
    const replyId = application.commercialCommandResponseSchemaId(spec.id);
    addComponent(`${spec.name}Completed`, byId[replyId], replyId);
    const responses = {
      [String(reply.status)]: {
        description: `COMPLETED: ${command.effect}`,
        headers: REPLY_HEADERS,
        content: { "application/json": { schema: { $ref: `${COMPONENTS}${spec.name}Completed` } } },
      },
    };
    if (reply.accepted) {
      responses["202"] = {
        description: "ACCEPTED: the included replacement's re-binding did not answer within its bound; the replacement quote stays ISSUED with its journal entry open — the operation (the replacement quote), its state, the quote's status path and the polling guidance; retry with the same key (package B10 D10-GAP-6a)",
        headers: REPLY_HEADERS,
        content: { "application/json": { schema: { $ref: `${COMPONENTS}AcceptedResponse` } } },
      };
    }
    Object.assign(responses, problemResponses(application.COMMERCIAL_COMMAND_OUTCOMES[spec.id]));
    const contract = application.commercialCommandRouteResponses(spec.id);
    const documented = Object.keys(responses).filter((status) => Number(status) < 400);
    if (!isDeepStrictEqual(documented.sort(), Object.keys(contract.declared).sort())) throw new Error(`${spec.id}: the documented replies ${documented} differ from the route's ${Object.keys(contract.declared)}`);
    serve(spec.method, spec.path, {
      operationId: spec.name,
      summary: `${spec.id} ${spec.name}`,
      description: `Precondition: ${command.precondition}

Effect: ${command.effect}

Failure: ${command.failure}`,
      "x-kauro-command": spec.id,
      "x-kauro-role": spec.role,
      "x-kauro-principal": spec.principal,
      "x-kauro-runtime-role": spec.runtimeRole,
      "x-kauro-scope": spec.scope,
      "x-kauro-idempotency": command.idempotency,
      "x-kauro-step-up": spec.stepUp ? "REQUIRED" : "NEVER",
      "x-kauro-gate": command.gate,
      "x-kauro-cases": command.testIds ?? [],
      "x-kauro-package": "B10",
      // the commission group's service commands (CMD051, CMD053) authenticate a verified service identity, every other a person
      security: [{ [spec.principal === "COMMERCIAL_SERVICE" ? "serviceAuth" : "bearerAuth"]: [] }],
      parameters: [
        ...pathParameters(spec.path).map((name) => ({ name, in: "path", required: true, description: "Path id, resolved with server-owned tenant scope (reference/COMMAND_CATALOGUE).", schema: ID })),
        { $ref: "#/components/parameters/IdempotencyKey" },
        ...(spec.scope === "AGENCY_HEADER" ? [{ $ref: "#/components/parameters/AgencySelector" }] : []),
        { $ref: "#/components/parameters/CorrelationId" },
      ],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: `${COMPONENTS}${spec.name}Request` } } } },
      responses,
    });
  }

  // package B10: the served commercial reads (GetCommissionStatement since B10-STATEMENTS-PAYOUTS; COMMERCIAL_SERVED_READ_IDS)
  for (const [operationId, spec] of Object.entries(application.COMMERCIAL_READ_ROUTES)) {
    if (!application.isServedCommercialRead(operationId)) continue;
    const schemaId = application.commercialReadResponseSchemaId(operationId);
    addComponent(`${operationId}Reply`, byId[schemaId], schemaId);
    serve("GET", spec.path, {
      operationId,
      summary: spec.summary,
      description: `Authority: ${spec.authority}`,
      "x-kauro-read": true,
      "x-kauro-role": spec.role,
      "x-kauro-scope": spec.scope,
      "x-kauro-package": "B10",
      security: [{ bearerAuth: [] }],
      parameters: [
        ...pathParameters(spec.path).map((name) => ({ name, in: "path", required: true, description: "Path id; a statement the caller may not read answers as an id nobody holds.", schema: ID })),
        { $ref: "#/components/parameters/CorrelationId" },
      ],
      responses: {
        200: { description: `READ: ${spec.summary}`, headers: REPLY_HEADERS, content: { "application/json": { schema: { $ref: `${COMPONENTS}${operationId}Reply` } } } },
        ...problemResponses(application.COMMERCIAL_READ_OUTCOMES[operationId]),
      },
    });
  }

  // the session routes' extra reply headers (B11 D-AUTH-1, D-PRIV-1): sign-in sets the cookie, logout clears it and the site data
  const sessionReplyHeaders = {
    openSession: { "Set-Cookie": { $ref: "#/components/headers/SetSessionCookie" } },
    revokeCurrentSession: { "Set-Cookie": { $ref: "#/components/headers/SetSessionCookie" }, "Clear-Site-Data": { $ref: "#/components/headers/ClearSiteData" } },
  };
  const cookieRoutes = new Set(["getCurrentSession", "revokeCurrentSession", "createStepUp"]);
  for (const route of operationalRoutes) {
    const contract = application.operationalRouteResponses(route.operationId, operationalRoutes);
    const responses = {};
    for (const [status, declared] of Object.entries(contract.declared)) {
      const headers = { ...REPLY_HEADERS, ...(sessionReplyHeaders[route.operationId] ?? {}) };
      if (declared.schemaId === null) {
        responses[status] = { description: route.responses[status].description, headers };
        continue;
      }
      const name = `${route.operationId}Response${status}`;
      addComponent(name, byId[declared.schemaId], declared.schemaId);
      responses[status] = {
        description: route.responses[status].description,
        headers,
        content: { [declared.contentType]: { schema: { $ref: `${COMPONENTS}${name}` } } },
      };
    }
    if (contract.outcomes === null) responses.default = problemResponse;
    else Object.assign(responses, problemResponses(contract.outcomes));
    const operation = { operationId: route.operationId, summary: route.summary, description: `Authority: ${route.authority}`, "x-kauro-operational": true };
    if (cookieRoutes.has(route.operationId)) operation.security = [{ sessionCookie: [] }, ...(route.operationId === "createStepUp" ? [{ bearerAuth: [] }] : [])];
    // the public routes (B11 W5b) take no credential: an explicit empty security requirement, not the document's silence
    if (route.path.startsWith("/api/v1/public/")) operation.security = [];
    // an unsafe route the session cookie authenticates carries the CSRF token; the fit inquiry names the Origin it demands
    const unsafe = route.method === "POST";
    if (route.path.startsWith("/api/v1/")) {
      operation.parameters = [
        { $ref: "#/components/parameters/CorrelationId" },
        ...(unsafe && cookieRoutes.has(route.operationId) ? [{ $ref: "#/components/parameters/CsrfToken" }] : []),
        ...(route.operationId === "createInquiry" ? [{ $ref: "#/components/parameters/InquiryOrigin" }] : []),
      ];
    }
    if (route.request !== undefined) {
      const requestId = application.operationalRequestSchemaId(route.operationId);
      addComponent(`${route.operationId}Request`, byId[requestId], requestId);
      operation.requestBody = { required: true, content: { [route.request.contentType]: { schema: { $ref: `${COMPONENTS}${route.operationId}Request` } } } };
    }
    operation.responses = responses;
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method.toLowerCase()]: operation };
  }

  addComponent("Problem", byId.Problem, "Problem");
  addComponent("AcceptedResponse", byId[application.ACCEPTED_RESPONSE_SCHEMA_ID], application.ACCEPTED_RESPONSE_SCHEMA_ID);
  // the definitions the envelopes reference, transitively, in their declared order
  const pending = [...Object.values(components.schemas).flatMap((s) => [...refsOf(s)])];
  while (pending.length > 0) {
    const name = pending.shift();
    if (name in components.schemas) continue;
    if (!(name in defs)) throw new Error(`a schema references ${name}, which is neither a view nor a registry definition`);
    components.schemas[name] = toComponent(defs[name]);
    pending.push(...refsOf(components.schemas[name]));
  }
  components.schemas = Object.fromEntries(Object.entries(components.schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const document = {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Kauro API",
      version: "v1",
      description:
        "Generated by tools/openapi.mjs; do not edit. Operations come from the vendored registry commands.json (provenance-verified); request schemas, the response views derived from the registry contracts, the envelopes and the Problem document are the application-owned schemas the api's closed validator compiles and its send guard validates every reply with. x-kauro-planned documents designed operations no route serves yet (keyed \"METHOD path\"), generated from the same contracts.",
      "x-kauro-registry": { "commands.json": provenance.files["commands.json"], "contracts.json": provenance.files["contracts.json"] },
    },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    "x-kauro-planned": Object.fromEntries(Object.entries(planned).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    components,
  };
  // brand amendment A2: every identifier this platform emits is Kauro; the document quotes registry prose, so it is checked
  const text = JSON.stringify(document);
  for (const brand of sources.legacyBrands) {
    if (new RegExp(brand, "i").test(text)) throw new Error("the generated document carries the pre-A2 brand; the quoted registry prose must be reviewed");
  }
  return document;
}

export function serialize(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

// --- the actual routes -----------------------------------------------------------------------------------------------------

/** The routes the api's composition root registers, with the replies each declares (apps/api routeInventoryOf). */
export async function registeredRoutes() {
  const [api, persistence] = await Promise.all([load("apps/api/dist/src/index.js"), load("packages/persistence/dist/src/index.js")]);
  // the real pg adapter, never connected: route registration opens no transaction, and the assertion below proves it
  const pool = persistence.createPool({ environment: "LOCAL", host: "127.0.0.1", port: 1, database: "kauro", user: "kauro_route_inventory", max: 1, applicationName: "kauro-openapi-inventory" });
  const boundaryPool = persistence.createPool({ environment: "LOCAL", host: "127.0.0.1", port: 1, database: "kauro", user: "kauro_route_inventory_sessions", max: 1, applicationName: "kauro-openapi-inventory-sessions" });
  try {
    // the composition root's own factory: the commerce unit of work over the app pool (the request side's reads bind to it)
    const unitOfWork = persistence.createCommerceUnitOfWorkFactory({ app: pool }, { clock: api.systemClock });
    // the readiness side of the database handle: the build's schema version, and a readiness read that refuses loudly, since
    // registering the routes serves no request (a probe answered here would be a defect of this tool, never a silent answer)
    const database = {
      codeSchemaVersion: persistence.listMigrations().reduce((max, file) => Math.max(max, file.version), 0),
      readiness: () => Promise.reject(new Error("the route inventory serves no request: readiness must not be read")),
    };
    // the session boundary (B11 W2) bound as a deployment binds it, over a never-connected kauro_assurance pool and a verifier
    // that refuses loudly: registering the session routes verifies no token and opens no session
    const sessions = {
      verifier: { verify: () => Promise.reject(new Error("the route inventory serves no request: no token is verified")) },
      store: new persistence.PgWebSessionStore(boundaryPool),
      appOrigins: ["https://app.kauro.invalid"],
      identityConfig: { adapter: "IDENTITY_PLATFORM", projectId: "kauro-inventory" },
    };
    // the public routes (B11 W5b) bound as a deployment binds them, over the never-connected runtime pool: registering them reads no
    // capability and stores no inquiry
    const publicApi = {
      origins: { public: "https://www.kauro.invalid", app: "https://app.kauro.invalid" },
      inquiries: new persistence.PgInquiryStore(pool),
      capabilities: new persistence.PgCapabilityPublication(pool),
      hashKey: new Uint8Array(32),
    };
    const app = api.assembleApi({ environment: "LOCAL", unitOfWork, database, authenticator: api.createBearerTokenAuthenticator(new Map()), sessions, publicApi });
    await app.ready();
    const inventory = api.routeInventoryOf(app);
    await app.close();
    if (pool.totalCount !== 0 || boundaryPool.totalCount !== 0) throw new Error("building the route inventory opened a database connection");
    return inventory;
  } finally {
    await pool.end();
    await boundaryPool.end();
  }
}

/** `/api/v1/plans/:planId/approve` -> `/api/v1/plans/{planId}/approve`. */
export function openApiPath(fastifyUrl) {
  return fastifyUrl.replace(/:([A-Za-z]+)/g, "{$1}");
}

// --- checking ----------------------------------------------------------------------------------------------------------------

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function operationsOf(document) {
  const out = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) if (item?.[method] !== undefined) out.push({ key: `${method.toUpperCase()} ${path}`, path, method, operation: item[method] });
  }
  return out;
}

/** JSON pointers where two values differ (bounded), for a readable drift report. */
function differences(a, b, at = "", out = []) {
  if (out.length >= 20) return out;
  if (isDeepStrictEqual(a, b)) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(at || "/");
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], `${at}/${String(k).replace(/~/g, "~0").replace(/\//g, "~1")}`, out);
  return out;
}

function resolveComponent(document, schema) {
  if (schema && typeof schema.$ref === "string" && schema.$ref.startsWith(COMPONENTS)) return { name: schema.$ref.slice(COMPONENTS.length), schema: document.components?.schemas?.[schema.$ref.slice(COMPONENTS.length)] };
  return { name: null, schema };
}

/** Whether a documented schema is the runtime schema: the component and every component it references, transitively. */
function sameSchema(document, documented, runtime, schemaId, defs) {
  const { schema } = resolveComponent(document, documented);
  if (schema === undefined || !isDeepStrictEqual(schema, toComponent(runtime, schemaId))) return false;
  const seen = new Set();
  const pending = [...refsOf(schema)];
  while (pending.length > 0) {
    const name = pending.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const component = document.components?.schemas?.[name];
    if (!(name in defs) || !isDeepStrictEqual(component, toComponent(defs[name]))) return false;
    pending.push(...refsOf(component));
  }
  return true;
}

/** Every member name a response schema declares, following component references. */
function responseMembers(document, schema) {
  const found = [];
  const seen = new Set();
  const walk = (s, at) => {
    if (Array.isArray(s)) return s.forEach((x, i) => walk(x, `${at}/${i}`));
    if (typeof s !== "object" || s === null) return;
    if (typeof s.$ref === "string" && s.$ref.startsWith(COMPONENTS)) {
      const name = s.$ref.slice(COMPONENTS.length);
      if (!seen.has(name)) {
        seen.add(name);
        walk(document.components?.schemas?.[name], `${COMPONENTS}${name}`);
      }
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && typeof v === "object" && v !== null) {
        for (const [name, sub] of Object.entries(v)) {
          found.push({ name, at: `${at}/properties/${name}` });
          walk(sub, `${at}/properties/${name}`);
        }
      } else if (k !== "enum" && k !== "const" && k !== "$ref") walk(v, `${at}/${k}`);
    }
  };
  walk(schema, "");
  return found;
}

/**
 * Checks a document against the generated one, the registered routes and the runtime schemas. Returns the failures (empty
 * when the document is the contract of the routes the api registers).
 */
export function checkOpenApi({ document, expected, inventory, sources }) {
  const failures = [];
  const { byId, defs } = runtimeSchemas(sources);
  const forbidden = sources.application.FORBIDDEN_RESPONSE_FIELDS;

  const drift = differences(document, expected);
  if (drift.length > 0) failures.push(`apps/api/openapi.json is not the generated document (run pnpm run openapi:generate); it differs at ${drift.join(", ")}`);

  const operations = operationsOf(document);
  const ids = new Map();
  for (const { key, operation } of operations) {
    if (typeof operation.operationId !== "string" || operation.operationId === "") failures.push(`missing operationId: ${key}`);
    else if (ids.has(operation.operationId)) failures.push(`duplicate operationId ${operation.operationId}: ${ids.get(operation.operationId)} and ${key}`);
    else ids.set(operation.operationId, key);
  }

  // planned operations (x-kauro-planned): never a registered route, never also served, operationIds unique across both lists
  const planned = Object.entries(document["x-kauro-planned"] ?? {});
  for (const [key, operation] of planned) {
    if (typeof operation?.operationId !== "string" || operation.operationId === "") failures.push(`missing operationId: planned ${key}`);
    else if (ids.has(operation.operationId)) failures.push(`duplicate operationId ${operation.operationId}: ${ids.get(operation.operationId)} and planned ${key}`);
    else ids.set(operation.operationId, `planned ${key}`);
  }

  const documented = new Map(operations.map((o) => [o.key, o]));
  const registered = new Map(inventory.map((r) => [`${r.method} ${openApiPath(r.url)}`, r]));
  for (const key of registered.keys()) if (!documented.has(key)) failures.push(`undocumented registered route: ${key}`);
  for (const key of documented.keys()) if (!registered.has(key)) failures.push(`documented route that is not registered: ${key}`);
  for (const [key] of planned) {
    if (registered.has(key)) failures.push(`planned route is registered: ${key} (a served route is documented under paths)`);
    if (documented.has(key)) failures.push(`planned route is also documented as served: ${key}`);
  }

  for (const [key, route] of registered) {
    const doc = documented.get(key);
    if (!doc) continue;
    const contract = route.responses;
    if (contract === null || contract === undefined) {
      failures.push(`registered route declares no response contract: ${key}`);
      continue;
    }
    if (doc.operation.operationId !== contract.operationId) failures.push(`operationId mismatch on ${key}: documented ${doc.operation.operationId}, registered ${contract.operationId}`);
    const responses = doc.operation.responses ?? {};
    // the problems: one "default" Problem for a route without a catalogue; one Problem per status of its catalogue otherwise,
    // listing exactly the route's outcomes of that status
    const problemStatuses = contract.outcomes === null ? ["default"] : problemResponsesOf(sources.application, contract.outcomes).map(([status]) => status);
    for (const status of Object.keys(responses)) {
      if (!(status in contract.declared) && !problemStatuses.includes(status)) failures.push(`response schema mismatch on ${key}: status ${status} is documented but the route does not declare it`);
    }
    if (contract.outcomes !== null) {
      for (const [status, entries] of problemResponsesOf(sources.application, contract.outcomes)) {
        if (!isDeepStrictEqual(responses[status]?.["x-kauro-outcomes"], entries)) failures.push(`outcome catalogue mismatch on ${key}: status ${status} does not document exactly the route's outcomes`);
      }
    }
    for (const [status, declared] of [...Object.entries(contract.declared), ...problemStatuses.map((s) => [s, contract.problem])]) {
      const content = responses[status]?.content;
      if (declared.schemaId === null) {
        if (responses[status] === undefined || content !== undefined) failures.push(`response schema mismatch on ${key}: status ${status} is declared without a body and must be documented without content`);
        continue;
      }
      const media = content?.[declared.contentType];
      if (!media) {
        failures.push(`response schema mismatch on ${key}: status ${status} is not documented as ${declared.contentType}`);
        continue;
      }
      if (Object.keys(content).length !== 1) failures.push(`response schema mismatch on ${key}: status ${status} documents other media types`);
      const runtime = byId[declared.schemaId];
      if (runtime === undefined) failures.push(`response schema mismatch on ${key}: status ${status} names ${declared.schemaId}, which the validator does not compile`);
      else if (!sameSchema(document, media.schema, runtime, declared.schemaId, defs)) failures.push(`response schema mismatch on ${key}: status ${status} is not the schema ${declared.schemaId} the route validates its replies with`);
    }
  }

  for (const { key, operation } of [...operations, ...planned.map(([plannedKey, operation]) => ({ key: `planned ${plannedKey}`, operation }))]) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      for (const media of Object.values(response?.content ?? {})) {
        for (const member of responseMembers(document, media.schema)) {
          if (member.name in forbidden) failures.push(`DTO exposes a forbidden field: ${key} ${status} ${member.at} (${forbidden[member.name]})`);
        }
      }
    }
  }
  return failures;
}

// --- command line --------------------------------------------------------------------------------------------------------------

async function main(mode) {
  const sources = await loadSources();
  const expected = generateOpenApi(sources);
  if (mode === "generate") {
    writeFileSync(DOCUMENT_PATH, serialize(expected));
    console.log(`openapi: wrote ${DOCUMENT_PATH} (${operationsOf(expected).length} operations, ${Object.keys(expected.components.schemas).length} schemas)`);
    return 0;
  }
  if (mode === "check") {
    const text = readFileSync(DOCUMENT_PATH, "utf8");
    const document = JSON.parse(text);
    const inventory = await registeredRoutes();
    const failures = checkOpenApi({ document, expected, inventory, sources });
    if (failures.length === 0 && text !== serialize(expected)) failures.push("apps/api/openapi.json is not byte-identical to the generated document (run pnpm run openapi:generate)");
    if (failures.length > 0) {
      for (const f of failures) console.error(`openapi: ${f}`);
      return 1;
    }
    console.log(`openapi: the document is the generated one and matches the ${inventory.length} registered routes (${operationsOf(document).length} operations, every operationId present, response schemas equal to the ones the routes validate with, every problem status documenting exactly its route's outcome catalogue, no forbidden field); ${Object.keys(document["x-kauro-planned"] ?? {}).length} planned operations, none registered or served`);
    return 0;
  }
  console.error("usage: node tools/openapi.mjs generate|check");
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv[2]);
}

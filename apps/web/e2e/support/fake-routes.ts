// ContractFakeAgencyApi (design section 6, D-E2E-2; label CONTRACT_FAKE, evidence class SIMULATED): the browser suite's stand-in for the
// operations an owning branch has only PLANNED (`x-kauro-planned`, descriptor `planned: true`): the session routes were, until W2 served
// them (B11 stage-1 integration); next B08's audit and plan reads, B16's invitation read and CMD004, B10's CMD002.
//   - It answers a planned operation and nothing else. A route whose descriptor is served is never answered (the edge forwards it to
//     the api or to the application), and a path no descriptor knows is left alone too. A fake that answered a served route would
//     make a green run mean nothing.
//   - It builds every reply from, and checks it against, the operation's planned schemas: the status must be one the descriptor
//     documents, the body must satisfy the schema of that status, a 204 has no body, a Problem is built with the request's own
//     correlation id and served as problem+json. A script that cannot be a real reply is refused when it is mounted, not when a
//     browser trips on it.
//   - It checks every request the way the real api will: the correlation id, the idempotency key exactly where the operation requires
//     one, the CSRF token on unsafe methods, the agency header exactly where the operation lists it (and equal to the path's agency),
//     only declared query parameters, and the body against the request schema. A request that breaks a rule is recorded as a violation
//     and answered with the operation's own refusal, so a spec can assert `violations()` is empty.
//   - It is never served outside the local stack: it refuses to exist unless KAURO_ENV is LOCAL.
// Everything is data in, data out: `handle` takes a request and returns a response or null (not ours), so the same code runs in a
// node test and behind the TLS edge (`mountOnEdge`, used by serve.mjs).
import type { IncomingMessage, ServerResponse } from "node:http";
import { OPERATIONS, SCHEMAS, type Problem } from "../../src/api/generated.ts";
import { type SchemaNode, validateAgainst } from "../../src/api/schema-guard.ts";
import type { WireDescriptor } from "../../src/client/api-client.ts";

/** The control endpoints a browser spec (another process) uses to script the fake, under the edge's own origin. */
export const CONTROL_PREFIX = "/__kauro-fake/";

const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const AGENCY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY = 1_048_576;

export type ProblemCode = Problem["code"];

/** What the fake answers: a body of the documented schema, or a Problem it builds itself. */
export type ReplyScript =
  | { readonly kind: "BODY"; readonly status: number; readonly body?: unknown }
  | { readonly kind: "PROBLEM"; readonly status: number; readonly code: ProblemCode; readonly retryable?: boolean };

export interface RecordedCall {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, string>>;
  readonly correlationId: string | null;
  readonly idempotencyKey: string | null;
  readonly csrfToken: string | null;
  readonly agencyHeader: string | null;
  readonly body: unknown;
  /** The rules this request broke, empty for a request the real api would accept. */
  readonly violations: readonly string[];
}

export type ScriptOf = ReplyScript | ((call: RecordedCall) => ReplyScript);

export interface EdgeRequest {
  readonly method: string;
  /** The request target: the path and its query string. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

export interface EdgeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeDeps {
  readonly operations: readonly WireDescriptor[];
  readonly schemas: Readonly<Record<string, SchemaNode>>;
  /** The environment the process runs in: the fake exists only for the local stack. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Operations that carry no CSRF token because no session exists yet. */
  readonly csrfExempt?: readonly string[];
}

const TITLES: Readonly<Record<ProblemCode, string>> = {
  INVALID_REQUEST: "The request is not valid",
  AUTHENTICATION_REQUIRED: "Authentication is required",
  ASSURANCE_REQUIRED: "A stronger sign-in is required",
  NOT_AUTHORIZED: "Not authorized",
  NOT_FOUND: "Not found",
  STALE_VERSION: "The record has changed",
  IDEMPOTENCY_CONFLICT: "The idempotency key was used for a different request",
  CAPABILITY_UNAVAILABLE: "The capability is not available",
  SOURCE_EXPIRED: "The source has expired",
  TARGET_STALE: "The target has changed",
  PLAN_NOT_VALIDATED: "The plan is not validated",
  PAYMENT_PENDING: "The payment is pending",
  PAYMENT_UNCERTAIN: "The payment outcome is not known",
  BUDGET_EXHAUSTED: "The budget is exhausted",
  CAPACITY_UNAVAILABLE: "No capacity is available",
  INTEGRITY_FAILURE: "An integrity check failed",
  OPERATION_CANCELLED: "The operation was cancelled",
  PRECONDITION_FAILED: "A precondition failed",
  ADMISSION_LIMITED: "Too many requests",
  CONTENT_REFUSED: "The submitted text was not accepted",
  INTERNAL_ERROR: "Something went wrong",
};

export class FakeMountError extends Error {
  readonly reason: "UNKNOWN_OPERATION" | "SERVED_ROUTE" | "OUTSIDE_LOCAL" | "STATUS_NOT_DOCUMENTED" | "REPLY_INVALID";
  constructor(reason: FakeMountError["reason"], message: string) {
    super(`${reason}: ${message}`);
    this.name = "FakeMountError";
    this.reason = reason;
  }
}

function oneHeader(headers: EdgeRequest["headers"], name: string): { readonly value: string | null; readonly repeated: boolean } {
  const raw = headers[name];
  if (raw === undefined) return { value: null, repeated: false };
  if (typeof raw === "string") return { value: raw, repeated: false };
  return { value: raw[0] ?? null, repeated: raw.length > 1 };
}

/** The path and query of an origin-form request target, or null for anything else (an absolute or protocol-relative URL, an asterisk, garbage). */
function targetOf(url: string): URL | null {
  if (!url.startsWith("/") || url.startsWith("//")) return null;
  try {
    return new URL(url, "http://fake.invalid");
  } catch {
    return null;
  }
}

function templateOf(path: string): { readonly pattern: RegExp; readonly names: readonly string[] } {
  const names: string[] = [];
  const source = path
    .split("/")
    .map((segment) => {
      const parameter = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(segment);
      if (parameter?.[1] === undefined) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(parameter[1]);
      return "([^/]+)";
    })
    .join("/");
  return { pattern: new RegExp(`^${source}$`), names };
}

function documentedSchema(descriptor: WireDescriptor, status: number): string | null | undefined {
  const own = Object.hasOwn(descriptor.replies, String(status)) ? descriptor.replies[String(status)] : undefined;
  if (own !== undefined) return own;
  return Object.hasOwn(descriptor.replies, "default") ? descriptor.replies["default"] : undefined;
}

interface Route {
  readonly descriptor: WireDescriptor;
  readonly pattern: RegExp;
  readonly names: readonly string[];
}

export class ContractFakeAgencyApi {
  readonly #deps: FakeDeps;
  readonly #routes: readonly Route[];
  readonly #scripts = new Map<string, ScriptOf>();
  readonly #once = new Map<string, ScriptOf[]>();
  #calls: RecordedCall[] = [];
  #violations: string[] = [];

  constructor(deps: FakeDeps) {
    if (deps.environment["KAURO_ENV"] !== "LOCAL") throw new FakeMountError("OUTSIDE_LOCAL", "the contract fake exists only for the local stack (KAURO_ENV=LOCAL)");
    this.#deps = deps;
    this.#routes = deps.operations.map((descriptor) => ({ descriptor, ...templateOf(descriptor.path) }));
  }

  /** The operations this fake may answer: the planned ones. */
  plannedOperations(): readonly string[] {
    return this.#deps.operations.filter((descriptor) => descriptor.planned).map((descriptor) => descriptor.operationId);
  }

  /** Answers every request of the operation with this script until it is replaced. A static script is checked now. */
  reply(operationId: string, script: ScriptOf): void {
    this.#check(operationId, script);
    this.#scripts.set(operationId, script);
  }

  /** Answers only the next request of the operation with this script; scripts queued earlier go first. */
  replyOnce(operationId: string, script: ScriptOf): void {
    this.#check(operationId, script);
    const queue = this.#once.get(operationId) ?? [];
    queue.push(script);
    this.#once.set(operationId, queue);
  }

  reset(): void {
    this.#scripts.clear();
    this.#once.clear();
    this.#calls = [];
    this.#violations = [];
  }

  calls(operationId?: string): readonly RecordedCall[] {
    return operationId === undefined ? [...this.#calls] : this.#calls.filter((call) => call.operationId === operationId);
  }

  /** Everything the fake refused or could not answer, in order: a spec asserts this is empty. */
  violations(): readonly string[] {
    return [...this.#violations];
  }

  #descriptor(operationId: string): WireDescriptor {
    const found = this.#deps.operations.find((descriptor) => descriptor.operationId === operationId);
    if (found === undefined) throw new FakeMountError("UNKNOWN_OPERATION", `${operationId} is not an operation this fake knows`);
    if (!found.planned) throw new FakeMountError("SERVED_ROUTE", `${operationId} is served: the fake answers planned operations only`);
    return found;
  }

  #check(operationId: string, script: ScriptOf): void {
    const descriptor = this.#descriptor(operationId);
    if (typeof script === "function") return;
    const built = this.#build(descriptor, script, "00000000-0000-7000-8000-000000000000");
    if (built.failures.length > 0) throw new FakeMountError(built.undocumented ? "STATUS_NOT_DOCUMENTED" : "REPLY_INVALID", `${operationId}: ${built.failures.join("; ")}`);
  }

  /** The reply a script stands for, or why it cannot be a reply of this operation. */
  #build(descriptor: WireDescriptor, script: ReplyScript, correlationId: string): { readonly response: EdgeResponse; readonly failures: readonly string[]; readonly undocumented: boolean } {
    const empty: EdgeResponse = { status: 500, headers: {}, body: "" };
    const documented = documentedSchema(descriptor, script.status);
    if (documented === undefined) return { response: empty, failures: [`status ${script.status} is not documented by ${descriptor.operationId}`], undocumented: true };
    const headers = { "cache-control": "no-store", "x-correlation-id": correlationId };
    if (documented === null) {
      if (script.kind !== "BODY" || script.body !== undefined) return { response: empty, failures: [`status ${script.status} of ${descriptor.operationId} has no body`], undocumented: false };
      return { response: { status: script.status, headers, body: "" }, failures: [], undocumented: false };
    }
    let body: unknown;
    if (script.kind === "PROBLEM") {
      if (documented !== "Problem") return { response: empty, failures: [`status ${script.status} of ${descriptor.operationId} is not a Problem`], undocumented: false };
      const problem: Problem = { type: `urn:kauro:problem:${script.code}`, title: TITLES[script.code], status: script.status, code: script.code, correlationId, retryable: script.retryable ?? false, nextActions: [] };
      body = problem;
    } else {
      if (script.body === undefined) return { response: empty, failures: [`status ${script.status} of ${descriptor.operationId} needs a body (${documented})`], undocumented: false };
      body = script.body;
    }
    const failures = validateAgainst(this.#deps.schemas, documented, body);
    if (failures.length > 0) return { response: empty, failures: failures.map((failure) => `${documented} ${failure}`), undocumented: false };
    return { response: { status: script.status, headers: { ...headers, "content-type": documented === "Problem" ? "application/problem+json" : "application/json" }, body: JSON.stringify(body) }, failures: [], undocumented: false };
  }

  /** The route a request addresses, whatever its status: served, planned or unknown (null). */
  #route(method: string, path: string): { readonly route: Route; readonly params: Readonly<Record<string, string>> } | null {
    for (const route of this.#routes) {
      if (route.descriptor.method.toUpperCase() !== method) continue;
      const match = route.pattern.exec(path);
      if (match === null) continue;
      const params: Record<string, string> = {};
      let readable = true;
      route.names.forEach((name, index) => {
        const raw = match[index + 1] ?? "";
        let value: string;
        try {
          value = decodeURIComponent(raw);
        } catch {
          readable = false;
          return;
        }
        params[name] = value;
      });
      if (readable) return { route, params };
    }
    return null;
  }

  /** Whether a request target is this fake's to answer (a planned operation or a control), decided without reading its body. */
  probe(method: string, url: string): boolean {
    const target = targetOf(url);
    if (target === null) return false;
    if (target.pathname.startsWith(CONTROL_PREFIX)) return true;
    return this.#route(method.toUpperCase(), target.pathname)?.route.descriptor.planned === true;
  }

  /** Answers the request when it addresses a planned operation; null when it is not this fake's to answer. */
  handle(request: EdgeRequest): EdgeResponse | null {
    const method = request.method.toUpperCase();
    const target = targetOf(request.url);
    if (target === null) return null;
    if (target.pathname.startsWith(CONTROL_PREFIX)) return this.#control(method, target, request.body);
    const found = this.#route(method, target.pathname);
    if (found === null || !found.route.descriptor.planned) return null;
    const { descriptor } = found.route;
    const call = this.#inspect(descriptor, found.params, method, target, request);
    this.#calls.push(call);
    for (const violation of call.violations) this.#violations.push(`${descriptor.operationId}: ${violation}`);
    const correlationId = call.correlationId !== null && CORRELATION_ID.test(call.correlationId) ? call.correlationId : "00000000-0000-7000-8000-000000000000";
    if (call.violations.length > 0) return this.#refusal(descriptor, correlationId);
    const script = this.#next(descriptor.operationId);
    if (script === undefined) {
      this.#violations.push(`${descriptor.operationId}: no reply is scripted`);
      return { status: 501, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: `contract fake: no reply is scripted for ${descriptor.operationId}\n` };
    }
    const chosen = typeof script === "function" ? script(call) : script;
    const built = this.#build(descriptor, chosen, correlationId);
    if (built.failures.length > 0) {
      this.#violations.push(`${descriptor.operationId}: the scripted reply is not a reply of the operation (${built.failures.join("; ")})`);
      return { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "contract fake: the scripted reply broke its own contract\n" };
    }
    return built.response;
  }

  #next(operationId: string): ScriptOf | undefined {
    const queue = this.#once.get(operationId);
    const queued = queue?.shift();
    if (queued !== undefined) return queued;
    return this.#scripts.get(operationId);
  }

  #inspect(descriptor: WireDescriptor, params: Readonly<Record<string, string>>, method: string, target: URL, request: EdgeRequest): RecordedCall {
    const violations: string[] = [];
    const correlation = oneHeader(request.headers, "x-correlation-id");
    if (correlation.value === null || correlation.repeated || !CORRELATION_ID.test(correlation.value)) violations.push("X-Correlation-Id is missing, repeated or not a UUID");
    const key = oneHeader(request.headers, "idempotency-key");
    if (descriptor.idempotency === "REQUIRED") {
      if (key.value === null || key.repeated || !IDEMPOTENCY_KEY.test(key.value)) violations.push("Idempotency-Key is missing, repeated or not 16 to 128 URL-safe characters");
    } else if (key.value !== null) violations.push("Idempotency-Key is sent to an operation that takes none");
    const csrf = oneHeader(request.headers, "x-kauro-csrf");
    if (method !== "GET" && !(this.#deps.csrfExempt ?? []).includes(descriptor.operationId) && (csrf.value === null || csrf.repeated || !CSRF_TOKEN.test(csrf.value))) violations.push("X-Kauro-CSRF is missing or malformed on an unsafe method");
    const agency = oneHeader(request.headers, "x-kauro-agency");
    if (descriptor.headers.includes("X-Kauro-Agency")) {
      if (agency.value === null || agency.repeated || !AGENCY_ID.test(agency.value)) violations.push("X-Kauro-Agency is missing or not an agency id");
      else if (params["agencyId"] !== undefined && params["agencyId"] !== agency.value) violations.push("X-Kauro-Agency differs from the agency in the path");
    } else if (agency.value !== null) violations.push("X-Kauro-Agency is sent to an operation that does not list it");
    for (const [name, value] of Object.entries(params)) if (!PATH_VALUE.test(value)) violations.push(`path parameter ${name} is malformed`);
    const query: Record<string, string> = {};
    for (const [name, value] of target.searchParams) {
      if (!descriptor.queryParameters.includes(name)) violations.push(`${name} is not a query parameter of the operation`);
      else if (Object.hasOwn(query, name)) violations.push(`${name} is repeated`);
      query[name] = value;
    }
    let body: unknown;
    if (descriptor.request === null) {
      if (request.body.length > 0) violations.push("the operation takes no request body");
    } else {
      const type = oneHeader(request.headers, "content-type").value;
      if (type === null || type.split(";")[0]?.trim().toLowerCase() !== "application/json") violations.push("the request body is not application/json");
      try {
        body = JSON.parse(request.body);
        for (const failure of validateAgainst(this.#deps.schemas, descriptor.request, body)) violations.push(`the body does not match ${descriptor.request}: ${failure}`);
      } catch {
        violations.push("the request body is not JSON");
      }
    }
    return { operationId: descriptor.operationId, method, path: target.pathname, query, params, correlationId: correlation.value, idempotencyKey: key.value, csrfToken: csrf.value, agencyHeader: agency.value, body, violations };
  }

  /** The operation's own refusal of a malformed request: its 400 (or 422, or the default) as a Problem. */
  #refusal(descriptor: WireDescriptor, correlationId: string): EdgeResponse {
    const status = ["400", "422"].find((candidate) => documentedSchema(descriptor, Number(candidate)) === "Problem") ?? (documentedSchema(descriptor, 400) === "Problem" ? "400" : null);
    if (status === null) return { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "contract fake: malformed request\n" };
    return this.#build(descriptor, { kind: "PROBLEM", status: Number(status), code: "INVALID_REQUEST" }, correlationId).response;
  }

  #control(method: string, target: URL, text: string): EdgeResponse {
    const json = (status: number, body: unknown): EdgeResponse => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
    const action = target.pathname.slice(CONTROL_PREFIX.length);
    if (method === "GET" && action === "calls") return json(200, { calls: this.calls(target.searchParams.get("operationId") ?? undefined) });
    if (method === "GET" && action === "violations") return json(200, { violations: this.violations() });
    if (method === "GET" && action === "operations") return json(200, { planned: this.plannedOperations() });
    if (method === "POST" && action === "reset") {
      this.reset();
      return { status: 204, headers: { "cache-control": "no-store" }, body: "" };
    }
    if (method === "POST" && (action === "reply" || action === "reply-once")) {
      try {
        const command = JSON.parse(text) as { readonly operationId?: unknown; readonly script?: unknown };
        if (typeof command.operationId !== "string" || typeof command.script !== "object" || command.script === null) return json(422, { error: "a reply command is {operationId, script}" });
        const script = command.script as ReplyScript;
        if (action === "reply") this.reply(command.operationId, script);
        else this.replyOnce(command.operationId, script);
        return { status: 204, headers: { "cache-control": "no-store" }, body: "" };
      } catch (error) {
        return json(422, { error: error instanceof Error ? error.message : "unreadable command" });
      }
    }
    return json(404, { error: "no such control" });
  }
}

/**
 * The one synthetic planned operation of the edge (B11 stage-1 integration, D-INT1-5). Once W2's session routes were served the generated
 * client planned nothing, so the harness keeps this planned operation of no owning branch to hold the edge's planned path to its rules.
 * It is no product operation: the api serves nothing at its path, no screen calls it, and like the fake it exists in the local stack only.
 */
export const HARNESS_PROBE: WireDescriptor = {
  operationId: "HarnessProbe",
  method: "get",
  path: "/api/v1/__kauro-harness/probe",
  command: null,
  role: null,
  idempotency: "NONE",
  headers: ["X-Correlation-Id"],
  pathParameters: [],
  queryParameters: [],
  request: null,
  replies: { "200": "HarnessProbeView", "401": "Problem", default: "Problem" },
  planned: true,
};

const HARNESS_SCHEMAS: Readonly<Record<string, SchemaNode>> = {
  HarnessProbeView: { type: "object", additionalProperties: false, required: ["probe"], properties: { probe: { type: "string", minLength: 1, maxLength: 64 } } },
};

/** The fake as the local stack's edge mounts it: every planned operation of the generated client, and the harness probe. */
export function createEdgeFake(environment: Readonly<Record<string, string | undefined>>): ContractFakeAgencyApi {
  return new ContractFakeAgencyApi({
    operations: [...(Object.values(OPERATIONS) as readonly WireDescriptor[]), HARNESS_PROBE],
    schemas: { ...(SCHEMAS as unknown as Readonly<Record<string, SchemaNode>>), ...HARNESS_SCHEMAS },
    environment,
  });
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // an oversized body is drained and discarded, so the refusal reaches a client that is still sending it
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    request.on("end", () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * The edge's hook: true when the fake answered the request, false when the edge should forward it as it always does. The body is read
 * only for a request the fake will answer, so a forwarded request reaches its upstream unread.
 */
export function mountOnEdge(fake: ContractFakeAgencyApi): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = request.url ?? "/";
    const method = request.method ?? "GET";
    // decide without the body first: a served route, an unknown path or a page is not ours and must not be consumed
    if (!fake.probe(method, url)) return false;
    const body = await readBody(request);
    if (body === null) {
      response.writeHead(413, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("contract fake: body too large\n");
      return true;
    }
    const answer = fake.handle({ method, url, headers: request.headers, body });
    if (answer === null) return false;
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
    return true;
  };
}

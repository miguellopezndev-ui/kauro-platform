// The browser's one way to call the api (design D-TOPO-1, D-GEN-1, D-PRIV-1; 10 "Request envelope"): same-origin /api/v1 under the
// session cookie, every request `cache: "no-store"`, `credentials: "same-origin"`, no redirect followed, a fresh correlation id, the
// active agency as `X-Kauro-Agency` where the operation needs it, the CSRF token of the session on unsafe methods, and the idempotency
// key the caller passes (the runner owns it; this client never mints one). Every reply is classified into an ApiAnswer (answer.ts): a
// reply that fails the generated guard is an integrity failure, an unreadable or missing reply is "no answer", and prose is never read.
import { OPERATIONS, type OperationDescriptor, type OperationId, type Problem, SCHEMAS, type SuccessReply } from "../api/generated.ts";
import { type SchemaNode, validateAgainst } from "../api/schema-guard.ts";
import type { ApiAnswer, IntegrityFailure, NoAnswerReason } from "./answer.ts";

export interface FetchInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly cache: "no-store";
  readonly credentials: "same-origin";
  readonly redirect: "error";
  readonly referrerPolicy: "no-referrer";
  readonly mode: "same-origin";
  readonly signal?: AbortSignal;
}

export interface FetchedResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchedResponse>;

/** What the client needs to know about the person's page; the session runtime provides it. */
export interface ClientContext {
  /** The X-Kauro-CSRF token of the current session, or null before a session exists. */
  csrfToken(): string | null;
  /** The agency the page is showing (from the URL), or null outside an agency. */
  activeAgency(): string | null;
}

/**
 * An operation as the client sends it: a generated descriptor, or one an owning package declares itself (the session routes until the
 * generator carries them). Schema names are strings so a supplementary schema table can name its own.
 */
export interface WireDescriptor extends Omit<OperationDescriptor, "request" | "replies"> {
  readonly request: string | null;
  readonly replies: Readonly<Record<string, string | null>>;
}

export interface ApiClientDeps {
  readonly fetch: FetchLike;
  readonly newCorrelationId: () => string;
  readonly context: ClientContext;
  /**
   * Told of every classified answer, after the caller's own classification is decided and without changing it. The session runtime
   * listens here so that a 401 from any call ends the private view, whichever screen made the call. It must not throw; if it does, the
   * failure goes to `reportObserverFailure` and the answer still reaches the caller (a command may already have committed).
   */
  readonly observe?: (answer: ApiAnswer<unknown>) => void;
  /** Where an observer's failure is reported. Default: rethrown from a microtask, so the page's error reporting sees it. */
  readonly reportObserverFailure?: (error: unknown) => void;
}

export interface CallInput {
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly body?: unknown;
  /** Required for an operation whose idempotency is REQUIRED; supplied by the OperationRunner. */
  readonly idempotencyKey?: string;
  readonly agency?: string;
  readonly signal?: AbortSignal;
}

const PATH_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const AGENCY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function urlFor(descriptor: WireDescriptor, input: CallInput): string {
  let path = descriptor.path;
  for (const name of descriptor.pathParameters) {
    const value = input.path?.[name];
    if (value === undefined || !PATH_VALUE.test(value)) throw new RangeError(`path parameter ${name} of ${descriptor.operationId} is missing or malformed`);
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  if (path.includes("{")) throw new RangeError(`${descriptor.operationId} has a path parameter its descriptor does not list`);
  const query: string[] = [];
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (!descriptor.queryParameters.includes(name)) throw new RangeError(`${name} is not a query parameter of ${descriptor.operationId}`);
    query.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return query.length === 0 ? path : `${path}?${query.join("&")}`;
}

function mediaTypeOf(response: FetchedResponse): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export class ApiClient {
  readonly #deps: ApiClientDeps;

  constructor(deps: ApiClientDeps) {
    this.#deps = deps;
  }

  /** Calls a generated operation. The body is typed by the api's own contract: it is the schema the reply was validated against. */
  call<Id extends OperationId>(operationId: Id, input: CallInput = {}): Promise<ApiAnswer<SuccessReply<Id>>> {
    return this.send<SuccessReply<Id>>(OPERATIONS[operationId], input, SCHEMAS);
  }

  /** Calls any operation descriptor against a table of schemas (the generated one, or a supplement an owning package declares). */
  async send<Body>(descriptor: WireDescriptor, input: CallInput, schemas: Readonly<Record<string, SchemaNode>>): Promise<ApiAnswer<Body>> {
    const { url, init, correlationId } = this.#request(descriptor, input, schemas);
    const answer = await this.#exchange<Body>(descriptor, url, init, schemas, correlationId);
    this.#tell(answer);
    return answer;
  }

  async #exchange<Body>(descriptor: WireDescriptor, url: string, init: FetchInit, schemas: Readonly<Record<string, SchemaNode>>, correlationId: string): Promise<ApiAnswer<Body>> {
    let response: FetchedResponse;
    try {
      response = await this.#deps.fetch(url, init);
    } catch (error) {
      return { kind: "NO_ANSWER", reason: noAnswerReason(error), status: null };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { kind: "NO_ANSWER", reason: "UNREADABLE", status: response.status };
    }
    return this.#classify<Body>(descriptor, response, text, schemas, correlationId);
  }

  #tell(answer: ApiAnswer<unknown>): void {
    const observe = this.#deps.observe;
    if (observe === undefined) return;
    try {
      observe(answer);
    } catch (error) {
      const report = this.#deps.reportObserverFailure ?? ((failure: unknown) => queueMicrotask(() => {
        throw failure;
      }));
      report(error);
    }
  }

  #request(descriptor: WireDescriptor, input: CallInput, schemas: Readonly<Record<string, SchemaNode>>) {
    const url = urlFor(descriptor, input);
    const correlationId = this.#deps.newCorrelationId();
    if (!CORRELATION_ID.test(correlationId)) throw new RangeError("a correlation id is a lowercase UUID of version 1 to 8");
    const headers: Record<string, string> = { Accept: "application/json, application/problem+json", "X-Correlation-Id": correlationId };
    if (descriptor.idempotency === "REQUIRED") {
      if (input.idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new RangeError(`${descriptor.operationId} needs an idempotency key of 16 to 128 URL-safe characters`);
      headers["Idempotency-Key"] = input.idempotencyKey;
    } else if (input.idempotencyKey !== undefined) throw new RangeError(`${descriptor.operationId} takes no idempotency key`);
    if (descriptor.headers.includes("X-Kauro-Agency")) {
      const agency = input.agency ?? this.#deps.context.activeAgency();
      if (agency === null || !AGENCY_ID.test(agency)) throw new RangeError(`${descriptor.operationId} needs the active agency`);
      headers["X-Kauro-Agency"] = agency;
    }
    if (descriptor.method !== "get") {
      const token = this.#deps.context.csrfToken();
      if (token !== null) headers["X-Kauro-CSRF"] = token;
    }
    let body: string | undefined;
    if (descriptor.request !== null) {
      if (input.body === undefined) throw new RangeError(`${descriptor.operationId} needs a request body`);
      const failures = validateAgainst(schemas, descriptor.request, input.body);
      if (failures.length > 0) throw new RangeError(`the request body of ${descriptor.operationId} does not match ${descriptor.request}: ${failures.join("; ")}`);
      body = JSON.stringify(input.body);
      headers["Content-Type"] = "application/json";
    } else if (input.body !== undefined) throw new RangeError(`${descriptor.operationId} takes no request body`);
    const init: FetchInit = {
      method: descriptor.method.toUpperCase(),
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "same-origin",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    return { url, init, correlationId };
  }

  #classify<Body>(descriptor: WireDescriptor, response: FetchedResponse, text: string, schemas: Readonly<Record<string, SchemaNode>>, sent: string): ApiAnswer<Body> {
    const status = response.status;
    // an answer the api did not write (a gateway page, a proxy timeout) says nothing about what the api did: the effect is unknown
    const unreadable: ApiAnswer<Body> = { kind: "NO_ANSWER", reason: "UNREADABLE", status };
    const integrity = (failure: IntegrityFailure): ApiAnswer<Body> => (status >= 500 ? unreadable : { kind: "INTEGRITY", status, correlationId: echoedOrNull(response), failure });
    const documented = Object.hasOwn(descriptor.replies, String(status)) ? descriptor.replies[String(status)] : descriptor.replies["default"];
    const expectsProblem = documented === undefined || documented === "Problem";

    if (documented === null) return status >= 200 && status < 300 ? { kind: "REPLY", status, correlationId: echoedOrNull(response) ?? sent, body: undefined as Body } : integrity("UNEXPECTED_STATUS");
    const media = mediaTypeOf(response);
    if (expectsProblem) {
      if (media !== "application/problem+json") return integrity("UNEXPECTED_MEDIA_TYPE");
      const parsed = parseJson(text);
      if (parsed === undefined || validateAgainst(schemas, "Problem", parsed).length > 0) return integrity(documented === undefined ? "UNEXPECTED_STATUS" : "PROBLEM_FAILED_CONTRACT");
      const problem = parsed as Problem;
      if (problem.status !== status) return integrity("PROBLEM_FAILED_CONTRACT");
      return { kind: "PROBLEM", status, correlationId: problem.correlationId, problem };
    }
    if (media !== "application/json") return integrity("UNEXPECTED_MEDIA_TYPE");
    const parsed = parseJson(text);
    if (parsed === undefined || validateAgainst(schemas, documented, parsed).length > 0) return integrity("REPLY_FAILED_CONTRACT");
    return { kind: "REPLY", status, correlationId: echoedOrNull(response) ?? sent, body: parsed as Body };
  }
}

function echoedOrNull(response: FetchedResponse): string | null {
  const echoed = response.headers.get("x-correlation-id");
  return echoed !== null && echoed.length >= 1 && echoed.length <= 128 ? echoed : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function noAnswerReason(error: unknown): NoAnswerReason {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "AbortError") return "ABORTED";
  if (name === "TimeoutError") return "TIMEOUT";
  return "NETWORK";
}

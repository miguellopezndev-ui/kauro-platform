// The review's stand-in for the network (Order 11). Every call a real screen makes goes through the web's own ApiClient, which checks
// each reply against the generated schemas; this function answers it from a scenario instead of the api, so a fixture that drifts from
// the contract shows as the real integrity failure rather than passing silently. Nothing leaves the browser: there is no fetch here.
import { OPERATIONS, type OperationId, type Problem } from "@web/api/generated.ts";
import type { FetchedResponse, FetchInit, FetchLike } from "@web/client/api-client.ts";

/** What one operation answers in a scenario: a body with its documented status, a Problem, or nothing yet (the loading state). */
export type Reply =
  | { readonly status: number; readonly body?: unknown }
  | { readonly status: number; readonly problem: Problem["code"]; readonly reason?: Problem["reason"]; readonly retryable?: boolean; readonly nextActions?: Problem["nextActions"] }
  | "PENDING";

export type Script = Partial<Record<OperationId, Reply | ((call: ReviewCall) => Reply)>>;

export interface ReviewCall {
  readonly operationId: OperationId | null;
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const ROUTES = Object.values(OPERATIONS).map((op) => {
  const names: string[] = [];
  const pattern = new RegExp(`^${op.path.replace(/\{([A-Za-z0-9]+)\}/g, (_, name: string) => (names.push(name), "([^/]+)"))}$`);
  return { op, names, pattern };
});

function route(method: string, path: string): { readonly operationId: OperationId; readonly params: Record<string, string> } | null {
  for (const { op, names, pattern } of ROUTES) {
    if (op.method !== method.toLowerCase()) continue;
    const found = pattern.exec(path);
    if (found === null) continue;
    const params: Record<string, string> = {};
    names.forEach((name, index) => (params[name] = decodeURIComponent(found[index + 1] ?? "")));
    return { operationId: op.operationId as OperationId, params };
  }
  return null;
}

function respond(status: number, body: unknown, correlationId: string, problem: boolean): FetchedResponse {
  const headers = new Map<string, string>([
    ["content-type", problem ? "application/problem+json" : "application/json"],
    ["x-correlation-id", correlationId],
  ]);
  return { status, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
}

/** A fetch that answers from `script`; `log` hears every call (the review's panel lists them, so the owner sees nothing is sent). */
export function fixtureFetch(script: () => Script, log: (call: ReviewCall, answered: string) => void): FetchLike {
  return async (url: string, init: FetchInit) => {
    const path = new URL(url, "http://review.invalid").pathname;
    const matched = route(init.method, path);
    let body: unknown = undefined;
    try {
      body = init.body === undefined ? undefined : JSON.parse(init.body);
    } catch {
      body = init.body;
    }
    const call: ReviewCall = { operationId: matched?.operationId ?? null, method: init.method, path, params: matched?.params ?? {}, body };
    const correlationId = init.headers["X-Correlation-Id"] ?? "00000000-0000-4000-8000-000000000000";
    const entry = matched === null ? undefined : script()[matched.operationId];
    const reply: Reply = typeof entry === "function" ? entry(call) : (entry ?? { status: 503, problem: "INTERNAL_ERROR", retryable: true });
    if (reply === "PENDING") {
      log(call, "pending (the screen waits)");
      return new Promise<FetchedResponse>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if ("problem" in reply) {
      log(call, `${reply.status} ${reply.problem}`);
      const problem: Problem = {
        type: `urn:kauro:problem:${reply.problem}`,
        title: reply.problem,
        status: reply.status,
        code: reply.problem,
        correlationId,
        ...(reply.reason === undefined ? {} : { reason: reply.reason }),
        retryable: reply.retryable ?? false,
        nextActions: reply.nextActions ?? [],
      };
      return respond(reply.status, problem, correlationId, true);
    }
    log(call, String(reply.status));
    return respond(reply.status, reply.body, correlationId, false);
  };
}

/**
 * The recorded wire: an HttpTransport that answers from fixtures under test/fixtures/wire (official PayPal API examples and declared
 * derivations of them, each with its URL, spec version and retrieval date) and records every request. Nothing here reaches the network.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TransportFailure, type HttpRequest, type HttpResponse, type HttpTransport, type TransportFailureKind } from "../../src/index.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/wire");

export interface Fixture {
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly http: { readonly method: string; readonly path: string; readonly status?: number; readonly body: unknown };
}

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as Fixture;
}

/** The exact bytes of a fixture's body (a webhook delivery is these bytes). */
export function fixtureBytes(name: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fixture(name).http.body));
}

export type Answer =
  | { readonly fixture: string; readonly status?: number }
  | { readonly status: number; readonly json?: unknown; readonly raw?: string }
  | { readonly fail: TransportFailureKind }
  /** Holds the call until the request's signal aborts (a provider that never answers before the deadline). */
  | { readonly hang: true };

interface Route {
  readonly method: string;
  readonly path: RegExp;
  readonly answers: Answer[];
}

export class RecordedWire {
  readonly requests: HttpRequest[] = [];
  private readonly routes: Route[] = [];
  private tokenAnswers: Answer[] = [];

  /** Queues answers for calls matching method and path (FIFO; the last answer repeats). */
  on(method: "GET" | "POST", path: RegExp, ...answers: Answer[]): this {
    this.routes.push({ method, path, answers: [...answers] });
    return this;
  }

  /** Overrides the OAuth token endpoint's answers (default: the documented token response). */
  token(...answers: Answer[]): this {
    this.tokenAnswers = [...answers];
    return this;
  }

  /** Requests to the API other than the token endpoint. */
  get apiRequests(): HttpRequest[] {
    return this.requests.filter((r) => !r.url.endsWith("/v1/oauth2/token"));
  }

  readonly transport: HttpTransport = async (request) => {
    this.requests.push(request);
    const path = new URL(request.url).pathname;
    let answer: Answer | undefined;
    if (path === "/v1/oauth2/token") {
      answer = this.tokenAnswers.length > 1 ? this.tokenAnswers.shift() : (this.tokenAnswers[0] ?? { fixture: "derived.oauth.post.200.token.json" });
    } else {
      const route = this.routes.find((r) => r.method === request.method && r.path.test(path));
      if (route === undefined) throw new Error(`recorded wire: no answer for ${request.method} ${path}`);
      answer = route.answers.length > 1 ? route.answers.shift() : route.answers[0];
    }
    if (answer === undefined) throw new Error("recorded wire: empty answer queue");
    return respond(answer, request.signal);
  };
}

async function respond(answer: Answer, signal: AbortSignal): Promise<HttpResponse> {
  if ("fail" in answer) throw new TransportFailure(answer.fail);
  if ("hang" in answer) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new TransportFailure("TIMEOUT");
  }
  if ("fixture" in answer) {
    const f = fixture(answer.fixture);
    return { status: answer.status ?? f.http.status ?? 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(f.http.body)) };
  }
  const text = answer.raw ?? (answer.json !== undefined ? JSON.stringify(answer.json) : "");
  return { status: answer.status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(text) };
}

export const DOC_CREDENTIALS = { read: async () => ({ clientId: "doc-example-client", clientSecret: "doc-example-secret" }) };

/** A controlled clock (fixed instant, advanced by hand); the adapters read time only through it. */
export function fixedClock(startMs = Date.UTC(2026, 9, 7, 12, 0, 0)): { now(): string; nowMs(): number; advance(ms: number): void } {
  let t = startMs;
  return { now: () => new Date(t).toISOString(), nowMs: () => t, advance: (ms) => void (t += ms) };
}

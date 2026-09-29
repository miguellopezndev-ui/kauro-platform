// OperationRunner (design D-OPS-1; case S066): one logical intent, one idempotency key, however many times the person activates it.
//   - The key is derived for a subject-bound command and minted once when a creation form opens (idempotency.ts); the runner never
//     mints a key inside `run`, so a double activation, a lost response, a reload and a second tab cannot produce a second one.
//   - A run that is already in flight in this page is joined, not repeated (the disabled button is a courtesy; correctness never depends
//     on it).
//   - A lost answer, a 5xx and OPERATION_PENDING (another tab or request is executing the same key) are retried with the SAME key, a
//     bounded number of times; then the durable resource is read. When the read cannot tell either, the state is Checking — never
//     "failed" and never a new key: an unexpected 500 does not mean a command did not commit (10 "Responses and safe errors").
//   - A definitive problem ends the run at once; a reply that failed the contract is an integrity failure and is never retried.
import type { Problem } from "../api/generated.ts";
import type { ApiAnswer, CommandBody, IntegrityFailure } from "./answer.ts";
import { type CommandId, deriveOperationKey, newFormKey } from "./idempotency.ts";

/** A creation form's key, minted when the form opened and kept until a COMPLETED answer. */
export interface FormHandle {
  readonly command: string;
  readonly key: string;
}

export type OperationSubject =
  | { readonly kind: "SUBJECT"; readonly subjectId: string; readonly subjectVersion: number | string }
  | { readonly kind: "FORM"; readonly form: FormHandle };

export type DurableRead<Data> =
  | { readonly kind: "RESOLVED"; readonly data: Data }
  | { readonly kind: "NOT_YET" }
  | { readonly kind: "NO_ANSWER" };

export type AcceptedBody = Extract<CommandBody<never>, { readonly kind: "ACCEPTED" }>;

export type RunOutcome<Data> =
  | { readonly kind: "COMPLETED"; readonly key: string; readonly data: Data; readonly version: number; readonly replayed: boolean; readonly attempts: number }
  | { readonly kind: "ACCEPTED"; readonly key: string; readonly accepted: AcceptedBody; readonly attempts: number }
  | { readonly kind: "PROBLEM"; readonly key: string; readonly problem: Problem; readonly status: number; readonly correlationId: string; readonly attempts: number }
  | { readonly kind: "INTEGRITY"; readonly key: string; readonly failure: IntegrityFailure; readonly correlationId: string | null; readonly attempts: number }
  | { readonly kind: "RECOVERED"; readonly key: string; readonly data: Data; readonly attempts: number }
  | { readonly kind: "CHECKING"; readonly key: string; readonly attempts: number; readonly lastRead: "NOT_YET" | "NO_ANSWER" | "NOT_ATTEMPTED" };

export interface RunRequest<Data> {
  readonly command: CommandId;
  readonly subject: OperationSubject;
  /** Sends the command once under `key`. Called again, with the same key, for every retry. */
  readonly send: (key: string) => Promise<ApiAnswer<CommandBody<Data>>>;
  /** Reads the durable resource the command creates or edits; called once when the retries end without a definitive answer. */
  readonly reread?: () => Promise<DurableRead<Data>>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  /** Pause before attempt n+1 (index n-1); the last entry repeats. Deterministic: no jitter, so a test owns every value. */
  readonly backoffMs: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, backoffMs: [250, 1000] };

export interface RunnerDeps {
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly policy?: RetryPolicy;
}

/** The runtime of a page: the real clock, the browser's entropy and a timer. */
export function browserRunnerDeps(): RunnerDeps {
  return {
    now: () => Date.now(),
    randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

/** A problem that says the effect may or may not have happened, or that another request is executing the same key: same-key retry. */
export function retriesWithSameKey(problem: Problem): boolean {
  if (problem.reason === "OPERATION_PENDING") return true;
  if (problem.status >= 500) return true;
  return problem.nextActions.some((next) => next.action === "RETRY_SAME_KEY");
}

export class OperationRunner {
  readonly #deps: RunnerDeps;
  readonly #policy: RetryPolicy;
  readonly #inFlight = new Map<string, Promise<RunOutcome<never>>>();

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? DEFAULT_RETRY_POLICY;
    if (!Number.isInteger(this.#policy.maxAttempts) || this.#policy.maxAttempts < 1) throw new RangeError("a run makes at least one attempt");
    if (this.#policy.backoffMs.length === 0) throw new RangeError("a retry policy names at least one pause");
  }

  /** Opens a creation form: its UUIDv7 key is minted now, at the instant the form is shown. */
  openForm(command: CommandId): FormHandle {
    return { command, key: newFormKey(this.#deps.now, this.#deps.randomBytes) };
  }

  async run<Data>(request: RunRequest<Data>): Promise<RunOutcome<Data>> {
    const key = await this.#keyOf(request);
    const identity = `${request.command}|${key}`;
    const running = this.#inFlight.get(identity);
    if (running !== undefined) return (await running) as RunOutcome<Data>;
    const started = this.#execute(request, key).finally(() => {
      this.#inFlight.delete(identity);
    });
    this.#inFlight.set(identity, started as Promise<RunOutcome<never>>);
    return started;
  }

  async #keyOf(request: RunRequest<unknown>): Promise<string> {
    if (request.subject.kind === "FORM") {
      if (request.subject.form.command !== request.command) throw new RangeError("a form's key belongs to the command it was opened for");
      return request.subject.form.key;
    }
    return deriveOperationKey(request.command, request.subject.subjectId, request.subject.subjectVersion);
  }

  async #execute<Data>(request: RunRequest<Data>, key: string): Promise<RunOutcome<Data>> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const answer = await request.send(key);
      let pause = 0;
      switch (answer.kind) {
        case "REPLY": {
          const body = answer.body;
          if (body.kind === "COMPLETED") return { kind: "COMPLETED", key, data: body.data, version: body.version, replayed: body.replayed, attempts };
          return { kind: "ACCEPTED", key, accepted: body, attempts };
        }
        case "INTEGRITY":
          return { kind: "INTEGRITY", key, failure: answer.failure, correlationId: answer.correlationId, attempts };
        case "PROBLEM":
          if (!retriesWithSameKey(answer.problem)) {
            return { kind: "PROBLEM", key, problem: answer.problem, status: answer.status, correlationId: answer.correlationId, attempts };
          }
          pause = (answer.problem.retryAfterSeconds ?? 0) * 1000;
          break;
        case "NO_ANSWER":
          break;
      }
      if (attempts >= this.#policy.maxAttempts) break;
      const scheduled = this.#policy.backoffMs[attempts - 1] ?? (this.#policy.backoffMs[this.#policy.backoffMs.length - 1] as number);
      await this.#deps.wait(Math.max(scheduled, pause));
    }
    return this.#recover(request, key, attempts);
  }

  async #recover<Data>(request: RunRequest<Data>, key: string, attempts: number): Promise<RunOutcome<Data>> {
    if (request.reread === undefined) return { kind: "CHECKING", key, attempts, lastRead: "NOT_ATTEMPTED" };
    let read: DurableRead<Data>;
    try {
      read = await request.reread();
    } catch {
      read = { kind: "NO_ANSWER" };
    }
    if (read.kind === "RESOLVED") return { kind: "RECOVERED", key, data: read.data, attempts };
    return { kind: "CHECKING", key, attempts, lastRead: read.kind };
  }
}

// OperationRunner (B11 design D-OPS-1; manual 10 "Idempotency contract": "A response lost after commit is recovered by the same key. The
// client does not generate a new key merely because it did not receive an answer"). The server here is a simulation of exactly that
// contract, kept in this file so the oracle is not the runner: a journal keyed by the Idempotency-Key that commits an effect once and
// replays the committed answer for the same key; a request that arrives while the first one is still in flight is answered
// PRECONDITION_FAILED / OPERATION_PENDING (retry with the same key); a response can be lost after the commit. The oracle of every
// case is the simulation's own record: the effects it committed and the keys it saw.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Problem } from "../src/api/generated.ts";
import type { ApiAnswer, CommandBody } from "../src/client/answer.ts";
import { KAURO_WEB_OPERATIONS, deriveOperationKey, newFormKey, operationKeyName, uuidV5 } from "../src/client/idempotency.ts";
import { OperationRunner, type DurableRead, type RunOutcome } from "../src/client/operation-runner.ts";

/** RFC 9562 UUIDv5 computed with node:crypto: the independent oracle of the runner's key. */
function oracleUuidV5(namespace: string, name: string): string {
  const digest = createHash("sha1").update(Buffer.from(namespace.replaceAll("-", ""), "hex")).update(Buffer.from(name, "utf8")).digest();
  digest[6] = ((digest[6] as number) & 0x0f) | 0x50;
  digest[8] = ((digest[8] as number) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NAMESPACE = "badaa28e-3e6f-4225-af2c-6d677b9b9ba2";
const QUOTE_ID = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f60";
const QUOTE_VERSION = 3;
const CORRELATION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f61";

const noEntropy = (): never => {
  throw new Error("a subject-bound intent drew entropy: it minted a key");
};
const noClock = (): never => {
  throw new Error("a subject-bound intent read the clock for a key");
};

function problem(code: Problem["code"], status: number, extra: Partial<Problem> = {}): Problem {
  return { type: `urn:kauro:problem:${code}`, title: code, status, code, correlationId: CORRELATION, retryable: false, nextActions: [], ...extra };
}

interface Effect {
  readonly command: string;
  readonly subject: string;
  readonly key: string;
}
interface Made {
  readonly id: string;
}
interface Gate {
  readonly arrived: Promise<void>;
  open(): void;
}

/** The journal contract of manual 10 in miniature: one commit per key, replay of the committed answer, OPERATION_PENDING while in flight. */
class SimulatedJournalApi {
  readonly effects: Effect[] = [];
  readonly keysSeen: string[] = [];
  readonly requests: { readonly key: string; readonly command: string }[] = [];
  private readonly committed = new Map<string, { readonly id: string; readonly version: number }>();
  private readonly inFlight = new Set<string>();
  private lost = 0;
  private gate: { arrived(): void; opened: Promise<void> } | null = null;

  loseNextResponses(count: number): void {
    this.lost = count;
  }

  /** Holds the next request that arrives after it committed nothing, until `open()`: a hold point, never a sleep. */
  holdNextRequest(): Gate {
    let arrived!: () => void;
    let open!: () => void;
    const arrivedPromise = new Promise<void>((resolve) => (arrived = resolve));
    const opened = new Promise<void>((resolve) => (open = resolve));
    this.gate = { arrived, opened };
    return { arrived: arrivedPromise, open };
  }

  async post(command: string, key: string, subject: string): Promise<ApiAnswer<CommandBody<Made>>> {
    this.keysSeen.push(key);
    this.requests.push({ key, command });
    const journaled = this.committed.get(key);
    if (journaled !== undefined) return this.answer(command, journaled, true);
    if (this.inFlight.has(key)) {
      return {
        kind: "PROBLEM",
        status: 409,
        correlationId: CORRELATION,
        problem: problem("PRECONDITION_FAILED", 409, { reason: "OPERATION_PENDING", retryable: true }),
      };
    }
    this.inFlight.add(key);
    const gate = this.gate;
    if (gate !== null) {
      this.gate = null;
      gate.arrived();
      await gate.opened;
    }
    const entry = { id: oracleUuidV5(NAMESPACE, `${command}:${subject}:effect:${this.effects.length}`), version: 1 };
    this.effects.push({ command, subject, key });
    this.committed.set(key, entry);
    this.inFlight.delete(key);
    return this.answer(command, entry, false);
  }

  private answer(_command: string, entry: { readonly id: string; readonly version: number }, replayed: boolean): ApiAnswer<CommandBody<Made>> {
    if (this.lost > 0) {
      this.lost -= 1;
      return { kind: "NO_ANSWER", reason: "NETWORK", status: null };
    }
    return { kind: "REPLY", status: 201, correlationId: CORRELATION, body: { kind: "COMPLETED", version: entry.version, replayed, data: { id: entry.id } } };
  }
}

/** A runner as a freshly loaded page has it: its own memory, no entropy and no clock for subject-bound keys. */
function pageRunner(wait: (ms: number) => Promise<void> = async () => {}): OperationRunner {
  return new OperationRunner({ now: noClock, randomBytes: noEntropy, wait });
}

function completed<D>(outcome: RunOutcome<D>): Extract<RunOutcome<D>, { kind: "COMPLETED" }> {
  assert.equal(outcome.kind, "COMPLETED", JSON.stringify(outcome));
  return outcome as Extract<RunOutcome<D>, { kind: "COMPLETED" }>;
}

const createPaymentOrder = (runner: OperationRunner, api: SimulatedJournalApi, reread?: () => Promise<DurableRead<Made>>) =>
  runner.run<Made>({
    command: "CMD028",
    subject: { kind: "SUBJECT", subjectId: QUOTE_ID, subjectVersion: QUOTE_VERSION },
    send: (key) => api.post("CMD028", key, `${QUOTE_ID}@${QUOTE_VERSION}`),
    ...(reread !== undefined ? { reread } : {}),
  });

const capturePayment = (runner: OperationRunner, api: SimulatedJournalApi, orderId: string, reread?: () => Promise<DurableRead<Made>>) =>
  runner.run<Made>({
    command: "CMD029",
    subject: { kind: "SUBJECT", subjectId: orderId, subjectVersion: QUOTE_VERSION },
    send: (key) => api.post("CMD029", key, orderId),
    ...(reread !== undefined ? { reread } : {}),
  });

test("S066: one logical intent keeps one idempotency key — a double activation, a lost response and a reload of CreatePaymentOrder and CapturePayment reuse the key derived from the quote version and the order, and never mint another", async () => {
  const api = new SimulatedJournalApi();
  const orderKey = oracleUuidV5(NAMESPACE, `CMD028:${QUOTE_ID}:${QUOTE_VERSION}`);

  // a double activation: the second click arrives while the first request is still in flight
  const page = pageRunner();
  const hold = api.holdNextRequest();
  const first = createPaymentOrder(page, api);
  await hold.arrived;
  const second = createPaymentOrder(page, api);
  hold.open();
  const [a, b] = await Promise.all([first, second]);
  const order = completed(a).data.id;
  assert.equal(completed(b).data.id, order, "both activations answer the one order");
  assert.equal(api.effects.length, 1, "one payment order was created");
  assert.deepEqual([...new Set(api.keysSeen)], [orderKey], "the key is the UUIDv5 of the quote and its version");

  // a lost response: the order was captured and the answer never arrived; the same key recovers it
  const captureKey = oracleUuidV5(NAMESPACE, `CMD029:${order}:${QUOTE_VERSION}`);
  api.loseNextResponses(1);
  const captured = completed(await capturePayment(page, api, order));
  assert.equal(captured.replayed, true, "the server replayed the committed capture");
  assert.equal(captured.attempts, 2, "one lost answer, one retry");
  assert.deepEqual(api.effects.filter((e) => e.command === "CMD029").map((e) => e.key), [captureKey], "one capture, under the derived key");

  // a reload: a new page has no memory and derives the same keys, so the server replays both effects
  const reloaded = pageRunner();
  assert.equal(completed(await createPaymentOrder(reloaded, api)).replayed, true);
  assert.equal(completed(await capturePayment(reloaded, api, order)).replayed, true);

  // a second tab in the middle of the first tab's request: OPERATION_PENDING is retried with the same key until the answer is durable
  const otherQuote = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99";
  const tabHold = api.holdNextRequest();
  const tabOne = pageRunner();
  const sendFor = (key: string) => api.post("CMD028", key, `${otherQuote}@${QUOTE_VERSION}`);
  const inFirstTab = tabOne.run<Made>({ command: "CMD028", subject: { kind: "SUBJECT", subjectId: otherQuote, subjectVersion: QUOTE_VERSION }, send: sendFor });
  await tabHold.arrived;
  const tabTwo = pageRunner(async () => {
    tabHold.open();
    await inFirstTab;
  });
  const inSecondTab = await tabTwo.run<Made>({ command: "CMD028", subject: { kind: "SUBJECT", subjectId: otherQuote, subjectVersion: QUOTE_VERSION }, send: sendFor });
  assert.equal(completed(inSecondTab).replayed, true);
  assert.equal(completed(await inFirstTab).data.id, completed(inSecondTab).data.id);

  // no key was ever minted: every request of every page carried a key equal to the UUIDv5 of its own intent
  const otherKey = oracleUuidV5(NAMESPACE, `CMD028:${otherQuote}:${QUOTE_VERSION}`);
  assert.deepEqual(
    api.requests.map((r) => r.key).filter((k) => ![orderKey, captureKey, otherKey].includes(k)),
    [],
    "no other key reached the server",
  );
  assert.equal(api.effects.filter((e) => e.command === "CMD028").length, 2, "one order per quote version: the first quote and the other quote");
  assert.equal(api.effects.filter((e) => e.command === "CMD029").length, 1, "one capture");

  // a new quote version is a new logical intent, and the same subject under another command is another one
  const v4 = oracleUuidV5(NAMESPACE, `CMD028:${QUOTE_ID}:${QUOTE_VERSION + 1}`);
  assert.notEqual(v4, orderKey);
  assert.equal(await deriveOperationKey("CMD028", QUOTE_ID, QUOTE_VERSION + 1), v4);
  assert.notEqual(await deriveOperationKey("CMD029", QUOTE_ID, QUOTE_VERSION), orderKey);
});

test("D-OPS-1: the key of a subject-bound intent is the UUIDv5 of CMDnnn:subjectId:subjectVersion in the pinned namespace, and a component that could shift the boundary is refused", async () => {
  assert.equal(KAURO_WEB_OPERATIONS, NAMESPACE);
  assert.equal(operationKeyName("CMD025", "plan-1", "a".repeat(64)), `CMD025:plan-1:${"a".repeat(64)}`);
  assert.equal(await deriveOperationKey("CMD028", QUOTE_ID, 3), oracleUuidV5(NAMESPACE, `CMD028:${QUOTE_ID}:3`));
  assert.match(await deriveOperationKey("CMD028", QUOTE_ID, 3), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // the RFC 9562 example: UUIDv5 of www.example.com in the DNS namespace
  assert.equal(await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
  for (const bad of ["a:b", "", " x", "x\n", "é"]) {
    await assert.rejects(() => deriveOperationKey("CMD028", bad, 1), RangeError, `subject ${JSON.stringify(bad)}`);
    await assert.rejects(() => deriveOperationKey("CMD028", QUOTE_ID, bad), RangeError, `version ${JSON.stringify(bad)}`);
  }
  await assert.rejects(() => deriveOperationKey("CMD28" as never, QUOTE_ID, 1), RangeError);
  await assert.rejects(() => deriveOperationKey("CMD028", QUOTE_ID, -1), RangeError);
  await assert.rejects(() => deriveOperationKey("CMD028", QUOTE_ID, 1.5), RangeError);
});

test("D-OPS-1: a form mints one UUIDv7 key when it opens and keeps it through a refusal, a lost answer and a repeated submission; a form opened later has another key", async () => {
  const api = new SimulatedJournalApi();
  let clock = 1_790_000_000_000;
  let counter = 0;
  const runner = new OperationRunner({
    now: () => clock,
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (counter + i * 7) & 0xff),
    wait: async () => {},
  });
  const form = runner.openForm("CMD009");
  assert.match(form.key, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Number.parseInt(form.key.replaceAll("-", "").slice(0, 12), 16), clock, "the UUIDv7 timestamp is the instant the form opened");
  clock += 60_000;
  counter += 1;
  const send = (key: string) => api.post("CMD009", key, "new client");

  api.loseNextResponses(2);
  const lostTwice = await runner.run<Made>({ command: "CMD009", subject: { kind: "FORM", form }, send });
  assert.equal(completed(lostTwice).attempts, 3, "two lost answers, then the replayed one, all under the form's key");
  const again = await runner.run<Made>({ command: "CMD009", subject: { kind: "FORM", form }, send });
  assert.equal(completed(again).replayed, true, "a repeated submission of the same form is a replay");
  assert.deepEqual([...new Set(api.keysSeen)], [form.key]);
  assert.equal(api.effects.length, 1);

  const next = runner.openForm("CMD009");
  assert.notEqual(next.key, form.key);
  assert.equal(await runner.run<Made>({ command: "CMD009", subject: { kind: "FORM", form }, send }).then((o) => completed(o).replayed), true);
  // a form belongs to the command it was opened for
  await assert.rejects(() => runner.run<Made>({ command: "CMD011", subject: { kind: "FORM", form }, send }), RangeError);
  assert.equal(newFormKey(() => clock, (n) => new Uint8Array(n)).slice(14, 15), "7");
});

test("D-OPS-1: same-key retries end in a durable re-read, and an answer that cannot be told is Checking, never failed and never a new key", async () => {
  const api = new SimulatedJournalApi();
  const waits: number[] = [];
  const runner = pageRunner(async (ms) => {
    waits.push(ms);
  });
  // every attempt is lost: the order is committed on the first, and only the durable read can say so
  api.loseNextResponses(99);
  const recovered = await createPaymentOrder(runner, api, async () => ({ kind: "RESOLVED", data: { id: "order-from-the-read-model" } }));
  assert.deepEqual(recovered, { kind: "RECOVERED", key: await deriveOperationKey("CMD028", QUOTE_ID, QUOTE_VERSION), data: { id: "order-from-the-read-model" }, attempts: 3 });
  assert.equal(api.requests.length, 3, "three attempts, no more");
  assert.deepEqual(waits.length, 2, "a wait between attempts, none after the last");
  assert.equal(new Set(api.keysSeen).size, 1);

  // the read cannot tell either: the person is told the payment is being checked, and the same key stays available
  const unsure = await createPaymentOrder(pageRunner(), api, async () => ({ kind: "NOT_YET" }));
  assert.equal(unsure.kind, "CHECKING");
  assert.equal((unsure as Extract<RunOutcome<Made>, { kind: "CHECKING" }>).lastRead, "NOT_YET");
  const silent = await createPaymentOrder(pageRunner(), api, async () => ({ kind: "NO_ANSWER" }));
  assert.equal((silent as Extract<RunOutcome<Made>, { kind: "CHECKING" }>).lastRead, "NO_ANSWER");
  const unread = await createPaymentOrder(pageRunner(), api);
  assert.equal((unread as Extract<RunOutcome<Made>, { kind: "CHECKING" }>).lastRead, "NOT_ATTEMPTED");
  assert.equal(new Set(api.keysSeen).size, 1, "Checking never mints a key");
});

test("D-OPS-1: a definitive problem ends the run at once, an INTERNAL_ERROR or CAPACITY_UNAVAILABLE that names RETRY_SAME_KEY is retried, and a reply that failed its contract is an integrity failure that is never retried", async () => {
  const runner = pageRunner();
  const send = (answers: ApiAnswer<CommandBody<Made>>[]) => {
    const seen: string[] = [];
    return {
      seen,
      send: async (key: string): Promise<ApiAnswer<CommandBody<Made>>> => {
        seen.push(key);
        return answers.shift() ?? { kind: "NO_ANSWER", reason: "NETWORK", status: null };
      },
    };
  };
  const denied = send([{ kind: "PROBLEM", status: 403, correlationId: CORRELATION, problem: problem("NOT_AUTHORIZED", 403) }]);
  const outcome = await runner.run<Made>({ command: "CMD028", subject: { kind: "SUBJECT", subjectId: QUOTE_ID, subjectVersion: 1 }, send: denied.send });
  assert.equal(outcome.kind, "PROBLEM");
  assert.equal(denied.seen.length, 1);

  const internal = send([
    { kind: "PROBLEM", status: 500, correlationId: CORRELATION, problem: problem("INTERNAL_ERROR", 500, { retryable: true, nextActions: [{ action: "RETRY_SAME_KEY" }] }) },
    { kind: "PROBLEM", status: 503, correlationId: CORRELATION, problem: problem("CAPACITY_UNAVAILABLE", 503, { retryable: true, retryAfterSeconds: 2, nextActions: [{ action: "RETRY_SAME_KEY" }] }) },
    { kind: "REPLY", status: 201, correlationId: CORRELATION, body: { kind: "COMPLETED", version: 1, replayed: true, data: { id: "x" } } },
  ]);
  const waits: number[] = [];
  const retried = await pageRunner(async (ms) => void waits.push(ms)).run<Made>({
    command: "CMD028",
    subject: { kind: "SUBJECT", subjectId: QUOTE_ID, subjectVersion: 1 },
    send: internal.send,
  });
  assert.equal(completed(retried).attempts, 3);
  assert.equal(new Set(internal.seen).size, 1);
  assert.ok((waits[1] ?? 0) >= 2000, "retryAfterSeconds is honoured");

  const skewed = send([{ kind: "INTEGRITY", status: 201, correlationId: CORRELATION, failure: "REPLY_FAILED_CONTRACT" }]);
  const integrity = await runner.run<Made>({ command: "CMD028", subject: { kind: "SUBJECT", subjectId: QUOTE_ID, subjectVersion: 1 }, send: skewed.send });
  assert.equal(integrity.kind, "INTEGRITY");
  assert.equal(skewed.seen.length, 1);

  const pending = send([{ kind: "PROBLEM", status: 409, correlationId: CORRELATION, problem: problem("PAYMENT_PENDING", 409, { retryable: true, nextActions: [{ action: "RETRY_LATER" }] }) }]);
  const pendingOutcome = await runner.run<Made>({ command: "CMD029", subject: { kind: "SUBJECT", subjectId: QUOTE_ID, subjectVersion: 1 }, send: pending.send });
  assert.equal(pendingOutcome.kind, "PROBLEM", "PAYMENT_PENDING is the state Pending, not a runner retry");
  assert.equal(pending.seen.length, 1);

  const accepted = send([{ kind: "REPLY", status: 202, correlationId: CORRELATION, body: { kind: "ACCEPTED", operationId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f62", state: "QUEUED", statusPath: "/api/v1/operations/x", pollAfterSeconds: 3 } }]);
  const acceptedOutcome = await runner.run<Made>({ command: "CMD036", subject: { kind: "SUBJECT", subjectId: QUOTE_ID, subjectVersion: 1 }, send: accepted.send });
  assert.equal(acceptedOutcome.kind, "ACCEPTED");
});

// B14-A: the worker's closed input and its only way to storage (docs/design/B14-A-worker-executor.md §3, §4). The attempt ticket is
// refused when it is not exactly the bytes the worker was started for, or not one attempt's complete, self-consistent input; the storage
// broker admits exactly the attempt's capability — its sealed generations read, its own staging prefix written — and nothing after it
// is revoked. Pure and in-process over B07's object-storage fake (CONTRACT FAKE — SIMULATED); no worker process here.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { ContractFakeObjectStorage } from "@kauro/application/testing";
import { stagedArtifactObjectNameOf } from "@kauro/application";
import { AttemptStorageBroker, BrokerRefusal, normalizeWorkerMessage, workerResultProblem, attemptTicketBytesOf, attemptTicketDigestOf, attemptTicketProblems, readAttemptTicket, type AttemptTicket, type WorkerCall } from "../src/index.js";
import { attemptFixture, collect, holderOf, sha } from "./support/attempt.js";
import { hostLimits, plantedAttempt } from "./support/local-host.js";

function ticketOf(storage: ContractFakeObjectStorage, n = 1): AttemptTicket {
  const planted = plantedAttempt(storage, n);
  return {
    identity: planted.fixture.identity,
    fence: 1,
    capability: planted.fixture.capability,
    subject: planted.fixture.subject,
    limits: hostLimits(),
    planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash },
    inputs: planted.inputs,
    reportInputs: null,
    render: { pageSize: "LETTER", locale: "en-US", rendererVersion: "renderer-1.0.0" },
    corePackageHash: sha("core"),
    issuedAt: "2026-10-18T12:00:00.000Z" as UtcInstant,
  };
}

test("B14-A ticket: the worker reads exactly the bytes it was started for — a ticket with another digest, altered after its digest was taken, not canonical, of another domain or too large is refused before anything is read from it", () => {
  const storage = new ContractFakeObjectStorage();
  const ticket = ticketOf(storage);
  const bytes = attemptTicketBytesOf(ticket);
  const digest = attemptTicketDigestOf(bytes);
  const read = readAttemptTicket(bytes, digest);
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual(read.ticket.inputs, ticket.inputs);
  assert.equal(readAttemptTicket(bytes, sha("another ticket")).ok, false);
  const altered = Buffer.from(bytes);
  altered[altered.length - 3] = altered[altered.length - 3]! ^ 1;
  assert.deepEqual(readAttemptTicket(altered, digest), { ok: false, problem: "TICKET_DIGEST_MISMATCH" });
  const spaced = Buffer.from(` ${Buffer.from(bytes).toString("utf8")}`);
  assert.deepEqual(readAttemptTicket(spaced, attemptTicketDigestOf(spaced)), { ok: false, problem: "TICKET_NOT_CANONICAL" });
  const foreign = Buffer.from(Buffer.from(bytes).toString("utf8").replace("KAURO_ATTEMPT_TICKET_V1", "KAURO_STAGED_MANIFEST_V1"));
  assert.deepEqual(readAttemptTicket(foreign, attemptTicketDigestOf(foreign)), { ok: false, problem: "TICKET_FOREIGN_DOMAIN" });
  const huge = new Uint8Array(8 * 1024 * 1024 + 1);
  assert.deepEqual(readAttemptTicket(huge, attemptTicketDigestOf(huge)), { ok: false, problem: "TICKET_TOO_LARGE" });
  // bytes inside the ticket travel as bytes
  const withLogo = { ...ticket, reportInputs: { logo: new Uint8Array([137, 80, 78, 71]) } as never };
  const again = readAttemptTicket(attemptTicketBytesOf(withLogo), attemptTicketDigestOf(attemptTicketBytesOf(withLogo)));
  assert.ok(again.ok);
  assert.deepEqual((again.ticket.reportInputs as unknown as { logo: Uint8Array }).logo, new Uint8Array([137, 80, 78, 71]));
});

test("B14-A ticket DENY: an incomplete or contradictory ticket is refused with its reason — another attempt's identity, capability or subject, no fence, limits past their hard bounds, no plan binding, inputs that are not exactly the capability's sealed generations, an unreadable read configuration, no render or core hash", () => {
  const storage = new ContractFakeObjectStorage();
  const good = ticketOf(storage);
  const other = attemptFixture(7);
  const cases: ReadonlyArray<readonly [string, AttemptTicket, string]> = [
    ["another attempt's identity", { ...good, identity: other.identity }, "IDENTITY_NOT_THE_ATTEMPTS"],
    ["another attempt's subject", { ...good, subject: { ...good.subject, attemptId: other.attemptId } }, "IDENTITY_NOT_THE_ATTEMPTS"],
    ["another job's subject", { ...good, subject: { ...good.subject, jobId: other.jobId } }, "SUBJECT_NOT_THE_CAPABILITYS"],
    ["a capability of another prefix", { ...good, capability: { ...good.capability, stagingPrefix: other.prefix } }, "CAPABILITY_PREFIX_NOT_THE_ATTEMPTS"],
    ["no fence", { ...good, fence: 0 }, "FENCE_MALFORMED"],
    ["a scratch budget past its hard bound", { ...good, limits: { ...good.limits, scratchBudgetBytes: good.limits.hardScratchBytes + 1 } }, "SCRATCH_BUDGET_PAST_HARD_LIMIT"],
    ["a memory budget past its hard bound", { ...good, limits: { ...good.limits, memoryBudgetBytes: good.limits.hardMemoryBytes + 1 } }, "MEMORY_BUDGET_PAST_HARD_LIMIT"],
    ["no wall clock", { ...good, limits: { ...good.limits, wallClockMs: 0 } }, "LIMITS_INCOMPLETE"],
    ["no plan binding hash", { ...good, planBinding: { configDocument: good.planBinding.configDocument, coreConfigHash: "nope" as Sha256Hex } }, "PLAN_BINDING_INCOMPLETE"],
    ["no inputs", { ...good, inputs: [] }, "INPUTS_NOT_THE_CAPABILITYS"],
    ["an input of another generation", { ...good, inputs: good.inputs.map((i) => ({ ...i, generation: `${i.generation}1` })) }, "INPUTS_NOT_THE_CAPABILITYS"],
    ["an input named twice", { ...good, inputs: [...good.inputs, ...good.inputs] }, "INPUTS_NOT_THE_CAPABILITYS"],
    ["an input with another digest", { ...good, inputs: good.inputs.map((i) => ({ ...i, sha256: sha("altered") })) }, "INPUTS_NOT_THE_CAPABILITYS"],
    ["an unreadable read configuration", { ...good, inputs: good.inputs.map((i) => ({ ...i, readConfig: { ...i.readConfig, format: "PDF" as never } })) }, "INPUT_READ_CONFIG_MALFORMED"],
    ["no render", { ...good, render: { ...good.render, rendererVersion: "" } }, "RENDER_INCOMPLETE"],
    ["no core package hash", { ...good, corePackageHash: "" as Sha256Hex }, "CORE_PACKAGE_HASH_MISSING"],
    ["no deadline", { ...good, subject: { ...good.subject, executionDeadlineAt: "never" as UtcInstant } }, "DEADLINE_MISSING"],
    ["an extra member", { ...good, extra: true } as unknown as AttemptTicket, "TICKET_NOT_CLOSED"],
  ];
  assert.deepEqual(attemptTicketProblems(good), []);
  for (const [label, ticket, problem] of cases) {
    assert.ok(attemptTicketProblems(ticket).includes(problem), `${label}: ${JSON.stringify(attemptTicketProblems(ticket))}`);
    const bytes = attemptTicketBytesOf(ticket);
    const read = readAttemptTicket(bytes, attemptTicketDigestOf(bytes));
    assert.equal(read.ok, false, label);
  }
});

function brokerOf(storage: ContractFakeObjectStorage, n = 1): { broker: AttemptStorageBroker; ticket: AttemptTicket } {
  const ticket = ticketOf(storage, n);
  return { broker: new AttemptStorageBroker({ capability: ticket.capability, storage, uploads: holderOf(storage), origin: "https://app.kauro.test", maxObjectBytes: 1 << 20 }), ticket };
}

async function refusal(broker: AttemptStorageBroker, call: WorkerCall): Promise<string> {
  try {
    await broker.handle(call);
  } catch (error) {
    if (error instanceof BrokerRefusal) return error.code;
    throw error;
  }
  return "ADMITTED";
}

test("B14-A broker OK: the worker reads exactly its sealed generations and writes, stats and reads back only inside its own staging prefix, through session handles that never carry the provider's bearer reference", async () => {
  const storage = new ContractFakeObjectStorage();
  const { broker, ticket } = brokerOf(storage);
  const [g] = ticket.capability.acceptedGenerations;
  const stream = (await broker.handle({ op: "storage.readOpen", zone: "ACCEPTED", objectName: g!.objectName, generation: g!.generation })) as number;
  const parts: Uint8Array[] = [];
  for (;;) {
    const chunk = (await broker.handle({ op: "storage.readNext", streamId: stream })) as Uint8Array | null;
    if (chunk === null) break;
    parts.push(chunk);
  }
  assert.equal(sha(Buffer.concat(parts)), g!.sha256);
  const name = stagedArtifactObjectNameOf(ticket.capability.stagingPrefix, "import", sha("01_IMPORT/a.csv"));
  const session = (await broker.handle({ op: "storage.createSession", zone: "STAGING", objectName: name, declaredBytes: 5, contentType: "text/csv", timeoutMs: 5000 })) as { handle: string };
  assert.match(session.handle, /^session-\d+$/, "an opaque handle, never the session URI");
  const answer = (await broker.handle({ op: "upload.writeChunk", handle: session.handle, chunk: Buffer.from("a,b\n1"), final: true })) as { outcome: string; generation: string };
  assert.equal(answer.outcome, "FINALIZED");
  assert.equal((await broker.handle({ op: "storage.stat", zone: "STAGING", objectName: name })) !== null, true);
  assert.equal((await collect(storage.read(storage.location("STAGING"), name, answer.generation))).toString(), "a,b\n1");
  assert.deepEqual(broker.refusals(), []);
});

test("B14-A broker DENY: another object, another generation of the sealed object, another project's or agency's object, another attempt's prefix, the manifest zone of delivery, a session past the hard bound, a handle it never issued and every call after its revocation are refused, and each refusal is kept as evidence", async () => {
  const storage = new ContractFakeObjectStorage();
  const { broker, ticket } = brokerOf(storage, 1);
  const neighbour = ticketOf(storage, 2);
  const [g] = ticket.capability.acceptedGenerations;
  const [ng] = neighbour.capability.acceptedGenerations;
  // the sealed object rewritten after the seal: its new generation is not the capability's
  const rewritten = storage.plantObject(storage.location("ACCEPTED"), g!.objectName, Buffer.from("Id,Email,Name\n9,x@example.com,X\n"), { overwrite: true });
  const cases: ReadonlyArray<readonly [string, WorkerCall, string]> = [
    ["another attempt's sealed object", { op: "storage.readOpen", zone: "ACCEPTED", objectName: ng!.objectName, generation: ng!.generation }, "OUTSIDE_CAPABILITY"],
    ["the sealed object's newer generation", { op: "storage.readOpen", zone: "ACCEPTED", objectName: g!.objectName, generation: rewritten.generation }, "OUTSIDE_CAPABILITY"],
    ["another agency's object", { op: "storage.readOpen", zone: "ACCEPTED", objectName: g!.objectName.replace(ticket.capability.agencyId, neighbour.capability.jobId), generation: g!.generation }, "OUTSIDE_CAPABILITY"],
    ["another attempt's staging", { op: "storage.readOpen", zone: "STAGING", objectName: `${neighbour.capability.stagingPrefix}${neighbour.capability.attemptId}`, generation: "1" }, "OUTSIDE_CAPABILITY"],
    ["a session in another attempt's prefix", { op: "storage.createSession", zone: "STAGING", objectName: neighbour.capability.manifestObjectName, declaredBytes: 5, contentType: "x", timeoutMs: 1 }, "OUTSIDE_CAPABILITY"],
    ["a session in DELIVERY", { op: "storage.createSession", zone: "DELIVERY" as never, objectName: ticket.capability.manifestObjectName, declaredBytes: 5, contentType: "x", timeoutMs: 1 }, "OUTSIDE_CAPABILITY"],
    ["a session past the hard bound", { op: "storage.createSession", zone: "STAGING", objectName: ticket.capability.manifestObjectName, declaredBytes: (1 << 20) + 1, contentType: "x", timeoutMs: 1 }, "OUTSIDE_CAPABILITY"],
    ["a stat of another prefix", { op: "storage.stat", zone: "STAGING", objectName: neighbour.capability.manifestObjectName }, "OUTSIDE_CAPABILITY"],
    ["a stat of ACCEPTED", { op: "storage.stat", zone: "ACCEPTED", objectName: g!.objectName }, "OUTSIDE_CAPABILITY"],
    ["a handle never issued", { op: "upload.writeChunk", handle: "session-999", chunk: Buffer.from("x"), final: true }, "OUTSIDE_CAPABILITY"],
    ["a provider session URI as a handle", { op: "upload.writeChunk", handle: "https://contract-fake-storage.invalid/session/1", chunk: Buffer.from("x"), final: true }, "OUTSIDE_CAPABILITY"],
    ["a deletion", { op: "storage.delete" } as unknown as WorkerCall, "OUTSIDE_CAPABILITY"],
    ["a read of an unknown stream", { op: "storage.readNext", streamId: 42 }, "STREAM_UNKNOWN"],
    ["a read without an exact generation", { op: "storage.readOpen", zone: "ACCEPTED", objectName: g!.objectName, generation: "0" }, "MALFORMED_CALL"],
  ];
  for (const [label, call, code] of cases) assert.equal(await refusal(broker, call), code, label);
  assert.equal(broker.refusals().length, cases.length);
  // an open session and a sealed read still work, until the revocation
  const open = (await broker.handle({ op: "storage.createSession", zone: "STAGING", objectName: ticket.capability.manifestObjectName, declaredBytes: 5, contentType: "x", timeoutMs: 1000 })) as { handle: string };
  await broker.revoke("TERMINATED_BY_HOST");
  assert.equal(await refusal(broker, { op: "upload.writeChunk", handle: open.handle, chunk: Buffer.from("12345"), final: true }), "REVOKED");
  assert.equal(await refusal(broker, { op: "storage.readOpen", zone: "ACCEPTED", objectName: g!.objectName, generation: g!.generation }), "REVOKED");
  assert.equal(await storage.stat(storage.location("STAGING"), ticket.capability.manifestObjectName), null, "nothing was written");
});

test("B14-A broker (review R5): a session whose creation lands after the revocation is cancelled at once and never handed over; a read answered after it is never delivered", async () => {
  const storage = new ContractFakeObjectStorage();
  const ticket = ticketOf(storage, 3);
  let land: () => void = () => undefined;
  const cancelled: string[] = [];
  // the fake keeps private state: a plain object delegates to it, with the creation held
  const paused = {
    location: (zone: Parameters<ContractFakeObjectStorage["location"]>[0]) => storage.location(zone),
    createResumableSession: async (...args: Parameters<ContractFakeObjectStorage["createResumableSession"]>) => {
      await new Promise<void>((resolve) => (land = resolve));
      return storage.createResumableSession(...args);
    },
    cancelResumableSession: (ref: string, timeoutMs: number) => {
      cancelled.push(ref);
      return storage.cancelResumableSession(ref, timeoutMs);
    },
  } as unknown as ContractFakeObjectStorage;
  const broker = new AttemptStorageBroker({ capability: ticket.capability, storage: paused, uploads: holderOf(storage), origin: "https://app.kauro.test", maxObjectBytes: 1 << 20 });
  const creating = broker.handle({ op: "storage.createSession", zone: "STAGING", objectName: ticket.capability.manifestObjectName, declaredBytes: 5, contentType: "x", timeoutMs: 1000 });
  await new Promise((r) => setImmediate(r));
  await broker.revoke("TERMINATED_BY_HOST");
  land();
  await assert.rejects(creating, (e: unknown) => e instanceof BrokerRefusal && e.code === "REVOKED");
  assert.equal(cancelled.length, 1, "the late session was cancelled");
  assert.equal(broker.cancelledLate, 1);
});

test("B14-A broker (review round 4, R4-4): the session cap holds for concurrent requests — a session's number is taken before the provider answers, so a second request while the first is pending is refused TOO_MANY_SESSIONS", async () => {
  const storage = new ContractFakeObjectStorage();
  const ticket = ticketOf(storage, 4);
  const lands: Array<() => void> = [];
  const held = {
    location: (zone: Parameters<ContractFakeObjectStorage["location"]>[0]) => storage.location(zone),
    createResumableSession: async (...args: Parameters<ContractFakeObjectStorage["createResumableSession"]>) => {
      await new Promise<void>((resolve) => lands.push(resolve));
      return storage.createResumableSession(...args);
    },
    cancelResumableSession: (ref: string, timeoutMs: number) => storage.cancelResumableSession(ref, timeoutMs),
  } as unknown as ContractFakeObjectStorage;
  const broker = new AttemptStorageBroker({ capability: ticket.capability, storage: held, uploads: holderOf(storage), origin: "https://app.kauro.test", maxObjectBytes: 1 << 20, maxSessions: 1 });
  const call = { op: "storage.createSession", zone: "STAGING", objectName: ticket.capability.manifestObjectName, declaredBytes: 5, contentType: "x", timeoutMs: 1000 } as const;
  const first = broker.handle(call);
  const second = broker.handle(call);
  await assert.rejects(second, (e: unknown) => e instanceof BrokerRefusal && e.code === "TOO_MANY_SESSIONS");
  await new Promise((r) => setImmediate(r));
  lands.forEach((land) => land());
  assert.equal(lands.length, 1, "the provider was asked once");
  assert.match(String(((await first) as { handle: string }).handle), /^session-1$/);
});

test("B14-A broker (review round 16, R16-1): what an attempt makes the host hold is bounded — one chunk at a time per session, and at most a fixed number of calls and bytes waiting at once; past them a call is refused at once, holding nothing", async () => {
  const storage = new ContractFakeObjectStorage();
  const ticket = ticketOf(storage, 5);
  const held: Array<() => void> = [];
  const real = holderOf(storage);
  const uploads = {
    ...real,
    writeChunk: async (...args: Parameters<typeof real.writeChunk>) => {
      await new Promise<void>((resolve) => held.push(resolve));
      return real.writeChunk(...args);
    },
  } as typeof real;
  const broker = new AttemptStorageBroker({ capability: ticket.capability, storage, uploads, origin: "https://app.kauro.test", maxObjectBytes: 1 << 20 });
  const handles: string[] = [];
  for (let i = 0; i < 17; i++) {
    const objectName = `${ticket.capability.stagingPrefix}${String(i).padStart(8, "0")}-0000-8000-8000-000000000000`;
    const session = (await broker.handle({ op: "storage.createSession", zone: "STAGING", objectName, declaredBytes: 4, contentType: "x", timeoutMs: 1000 })) as { handle: string };
    handles.push(session.handle);
  }
  const chunk = new Uint8Array([1, 2, 3, 4]);
  const first = broker.handle({ op: "upload.writeChunk", handle: handles[0]!, chunk, final: true });
  await assert.rejects(broker.handle({ op: "upload.writeChunk", handle: handles[0]!, chunk, final: true }), (e: unknown) => e instanceof BrokerRefusal && e.code === "SESSION_BUSY");
  const waiting = [first, ...handles.slice(1, 16).map((handle) => broker.handle({ op: "upload.writeChunk", handle, chunk, final: true }))];
  await assert.rejects(broker.handle({ op: "upload.writeChunk", handle: handles[16]!, chunk, final: true }), (e: unknown) => e instanceof BrokerRefusal && e.code === "TOO_MANY_PENDING");
  await new Promise((r) => setImmediate(r));
  held.splice(0).forEach((release) => release());
  await Promise.allSettled(waiting);
  // released: the budget is free again
  const again = broker.handle({ op: "upload.writeChunk", handle: handles[16]!, chunk, final: true });
  await new Promise((r) => setImmediate(r));
  held.splice(0).forEach((release) => release());
  await again;
});

test("B14-A broker and protocol (review round 17, R17-1): nothing a worker sends is kept unbounded — an unknown operation is recorded as UNKNOWN, never as its own string, and a result outside the closed, bounded shape is no result", async () => {
  const storage = new ContractFakeObjectStorage();
  const ticket = ticketOf(storage, 6);
  const broker = new AttemptStorageBroker({ capability: ticket.capability, storage, uploads: holderOf(storage), origin: "https://app.kauro.test", maxObjectBytes: 1 << 20 });
  const huge = "x".repeat(1 << 20);
  await assert.rejects(broker.handle({ op: huge } as unknown as WorkerCall), (e: unknown) => e instanceof BrokerRefusal);
  assert.deepEqual(broker.refusals().at(-1), { op: "UNKNOWN", code: "OUTSIDE_CAPABILITY" });
  const ok = { state: "SUCCEEDED", cause: null, manifest: { objectName: "x", generation: "12" }, refusal: null, peakScratchBytes: 1, peakMemoryBytes: 2 };
  assert.equal(workerResultProblem(ok), null);
  assert.equal(workerResultProblem({ ...ok, refusal: huge }), "RESULT_REFUSAL");
  assert.equal(workerResultProblem({ ...ok, extra: 1 }), "RESULT_FIELDS");
  assert.equal(workerResultProblem({ ...ok, manifest: { objectName: "x", generation: "12", sha256: huge } }), "RESULT_MANIFEST");
  assert.equal(workerResultProblem({ ...ok, cause: huge }), "RESULT_CAUSE");
  assert.equal(workerResultProblem({ ...ok, state: "DONE" }), "RESULT_STATE");
  assert.equal(workerResultProblem({ ...ok, peakMemoryBytes: -1 }), "RESULT_PEAKS");
});

test("B14-A protocol (review round 18, R18-1): the host keeps only the protocol's own fields of a call, each bounded, and a chunk in bytes of its own — padding and the frame a chunk arrived in are not held while the call waits", () => {
  const frame = new Uint8Array(1 << 20);
  const chunk = frame.subarray(0, 4);
  const padded = { t: "call", id: 7, call: { op: "upload.writeChunk", handle: "session-1", chunk, final: false, padding: new Uint8Array(1 << 20) }, extra: "x".repeat(1 << 16) };
  const kept = normalizeWorkerMessage(padded);
  assert.ok(kept !== null && kept.t === "call" && kept.call.op === "upload.writeChunk");
  assert.deepEqual(Object.keys(kept.call).sort(), ["chunk", "final", "handle", "op"]);
  assert.equal(kept.call.chunk.buffer.byteLength, 4, "the chunk's bytes are its own, not the frame's");
  assert.notEqual(kept.call.chunk.buffer, frame.buffer);
  assert.deepEqual(normalizeWorkerMessage({ t: "call", id: 8, call: { op: "storage.stat", zone: "STAGING", objectName: "x".repeat(4096) } }), { t: "invalid", id: 8, problem: "MALFORMED_CALL" });
  assert.deepEqual(normalizeWorkerMessage({ t: "call", id: 9, call: { op: "x".repeat(1 << 16) } }), { t: "invalid", id: 9, problem: "MALFORMED_CALL" });
  assert.equal(normalizeWorkerMessage({ t: "call", id: "nine", call: {} }), null, "no answerable id: ignored");
  const result = normalizeWorkerMessage({ t: "result", result: { state: "FAILED", cause: "WORKER_ERROR", manifest: null, refusal: null, peakScratchBytes: 0, peakMemoryBytes: 0, padding: 1 } });
  assert.deepEqual(result, { t: "result", result: { state: "FAILED", cause: "WORKER_ERROR", manifest: null, refusal: "RESULT_FIELDS", peakScratchBytes: 0, peakMemoryBytes: 0 } });
});

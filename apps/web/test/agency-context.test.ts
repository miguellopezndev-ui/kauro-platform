// The agency context of the shell (design D-PRIV-1, D-DS-3; 11 "Agency context stays visible"): which agency the page is showing, read from
// the api under the session, drawn only while the session is confirmed, and trusted only when the api names the agency the URL names. The
// oracle is the design's rule that a page never shows a fact it cannot vouch for: a reply for another agency, a refusal, a reply that
// fails the contract, all end as one message ("not available") and never as a name. The session is scripted through a fake with the
// runtime's own two methods, and every answer arrives when the test says so; nothing waits on a clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgencyView, GetAgencyReply, Problem } from "../src/api/generated.ts";
import type { ApiAnswer } from "../src/client/answer.ts";
import type { SessionPhase } from "../src/client/session.ts";
import { type AgencyContext, AgencyContextRuntime, agencyContextOf, roleOf } from "../src/shell/agency-context.ts";

const AGENCY_A = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1";
const AGENCY_B = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb2";
const CORRELATION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99";

const SIGNED_IN: SessionPhase = { kind: "SIGNED_IN", session: { userId: "user-1", emailVerified: true, mfaEnrolled: true, mfaAt: null, stepUpFreshUntil: null, idleExpiresAt: "2026-09-29T10:30:00Z", absoluteExpiresAt: "2026-09-29T22:00:00Z" } };

function agency(agencyId: string, displayName = "Northwind Data", state: AgencyView["state"] = "ACTIVE"): AgencyView {
  return { agencyId, version: 3, displayName, state, createdAt: "2026-09-01T09:00:00Z", permittedActions: ["VIEW"] };
}

const replied = (view: AgencyView): ApiAnswer<GetAgencyReply> => ({ kind: "REPLY", status: 200, correlationId: CORRELATION, body: { kind: "READ", data: view } });
const problemOf = (status: number, code: Problem["code"]): Problem => ({ type: `urn:kauro:problem:${code}`, title: "x", status, code, correlationId: CORRELATION, retryable: false, nextActions: [] });
const refused = (status: number, code: Problem["code"]): ApiAnswer<never> => ({ kind: "PROBLEM", status, correlationId: CORRELATION, problem: problemOf(status, code) });
const lost = (): ApiAnswer<never> => ({ kind: "NO_ANSWER", reason: "NETWORK", status: null });
const skewed = (): ApiAnswer<never> => ({ kind: "INTEGRITY", status: 200, correlationId: CORRELATION, failure: "REPLY_FAILED_CONTRACT" });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A session with the two methods the context follows; `enter` moves it to a phase and tells every listener. */
function fakeSession() {
  let phase: SessionPhase = { kind: "CHECKING" };
  const listeners = new Set<() => void>();
  return {
    snapshot: () => phase,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enter(next: SessionPhase): void {
      phase = next;
      for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
}

interface Asked {
  readonly agencyId: string;
  readonly signal: AbortSignal;
  readonly answer: (answer: ApiAnswer<GetAgencyReply>) => void;
  /** The promise the runtime awaits: its own continuation was registered first, so it has run once this settles for the test. */
  readonly reply: Promise<unknown>;
}

/** A context whose reads wait for the test. */
function world(agencyId: string | null = AGENCY_A) {
  const session = fakeSession();
  const asked: Asked[] = [];
  const context = new AgencyContextRuntime({
    agencyId,
    read: (id, signal) => {
      const call = deferred<ApiAnswer<GetAgencyReply>>();
      asked.push({ agencyId: id, signal, answer: (answer) => call.resolve(answer), reply: call.promise });
      return call.promise;
    },
  });
  const stop = context.follow(session);
  const seen: string[] = [];
  context.subscribe(() => seen.push(context.snapshot().kind));
  /** Answers the oldest waiting read and returns once the context has applied (or ignored) the answer. */
  const answerNext = async (answer: ApiAnswer<GetAgencyReply>): Promise<void> => {
    const call = asked.shift();
    assert.ok(call, "no read is waiting for an answer");
    call.answer(answer);
    await call.reply;
  };
  return { session, context, asked, seen, stop, answerNext };
}

test("D-PRIV-1: a reply is trusted only when it names the agency the URL names; a refusal, a lost answer, a skewed answer or another agency is one message and never a name", () => {
  const cases: ReadonlyArray<readonly [string, ApiAnswer<GetAgencyReply>, AgencyContext]> = [
    ["the agency of the URL", replied(agency(AGENCY_A, "Northwind Data", "RESTRICTED")), { kind: "READY", agencyId: AGENCY_A, displayName: "Northwind Data", state: "RESTRICTED", role: null }],
    ["another agency's reply", replied(agency(AGENCY_B, "Someone Else")), { kind: "UNAVAILABLE" }],
    ["not authorized", refused(403, "NOT_AUTHORIZED"), { kind: "UNAVAILABLE" }],
    ["not found", refused(404, "NOT_FOUND"), { kind: "UNAVAILABLE" }],
    ["an internal error", refused(500, "INTERNAL_ERROR"), { kind: "UNAVAILABLE" }],
    ["no answer", lost(), { kind: "UNAVAILABLE" }],
    ["an answer that fails the contract", skewed(), { kind: "UNAVAILABLE" }],
  ];
  for (const [label, answer, expected] of cases) assert.deepEqual(agencyContextOf(AGENCY_A, answer), expected, label);
});

test("D-PRIV-1: outside an agency there is no context and nothing is asked; inside one nothing is asked before the session is confirmed", async () => {
  const outside = world(null);
  assert.deepEqual(outside.context.snapshot(), { kind: "NONE" });
  outside.session.enter(SIGNED_IN);
  assert.equal(outside.asked.length, 0, "a page outside an agency reads no agency");
  assert.deepEqual(outside.context.snapshot(), { kind: "NONE" });

  const inside = world();
  assert.deepEqual(inside.context.snapshot(), { kind: "LOADING" });
  for (const phase of [{ kind: "CHECKING" }, { kind: "SIGNED_OUT" }, { kind: "UNAVAILABLE", reason: "NO_ANSWER" }, { kind: "LEAVING" }, { kind: "SWITCHING", agencyId: AGENCY_B }] as const) {
    inside.session.enter(phase);
    assert.equal(inside.asked.length, 0, `${phase.kind}: no read`);
    assert.deepEqual(inside.context.snapshot(), { kind: "LOADING" }, `${phase.kind}: no name`);
  }
  inside.session.enter(SIGNED_IN);
  assert.equal(inside.asked.length, 1);
  assert.equal(inside.asked[0]?.agencyId, AGENCY_A, "the read names the agency of the URL");
  await inside.answerNext(replied(agency(AGENCY_A)));
  assert.deepEqual(inside.context.snapshot(), { kind: "READY", agencyId: AGENCY_A, displayName: "Northwind Data", state: "ACTIVE", role: null });
});

test("D-PRIV-1: the name is dropped the moment the session is no longer confirmed, and a read that was still on its way is aborted and its answer ignored", async () => {
  const w = world();
  w.session.enter(SIGNED_IN);
  await w.answerNext(replied(agency(AGENCY_A)));
  assert.equal(w.context.snapshot().kind, "READY");

  // pagehide: the session goes back to CHECKING and the context forgets at once
  w.session.enter({ kind: "CHECKING" });
  assert.deepEqual(w.context.snapshot(), { kind: "LOADING" }, "no name while the session is being read again");

  // the session is confirmed again: the agency is read again, and only its answer counts
  w.session.enter(SIGNED_IN);
  assert.equal(w.asked.length, 1);
  const inFlight = w.asked[0];
  assert.ok(inFlight);
  w.session.enter({ kind: "CHECKING" });
  assert.equal(inFlight.signal.aborted, true, "the read of a session that no longer stands is aborted");
  await w.answerNext(replied(agency(AGENCY_A, "Late Name")));
  assert.deepEqual(w.context.snapshot(), { kind: "LOADING" }, "a late answer never draws");
});

test("D-PRIV-1: a refusal for the agency is the same message as a stranger's agency, and Check again (a fresh sign-in read) asks again", async () => {
  const w = world();
  w.session.enter(SIGNED_IN);
  await w.answerNext(refused(403, "NOT_AUTHORIZED"));
  assert.deepEqual(w.context.snapshot(), { kind: "UNAVAILABLE" });
  // the person chooses Check again: the session is read again (CHECKING) and confirmed again
  w.session.enter({ kind: "CHECKING" });
  w.session.enter(SIGNED_IN);
  assert.equal(w.asked.length, 1, "asked again");
  await w.answerNext(replied(agency(AGENCY_A)));
  assert.equal(w.context.snapshot().kind, "READY");
});

test("D-PRIV-1: a background re-confirmation refreshes the agency in place; a refusal ends the context, a lost answer keeps it", async () => {
  const w = world();
  w.session.enter(SIGNED_IN);
  await w.answerNext(replied(agency(AGENCY_A, "Northwind Data", "ACTIVE")));

  // the tab comes back: the session re-reads as the same person (a new SIGNED_IN with no phase in between)
  w.session.enter({ ...SIGNED_IN });
  assert.equal(w.asked.length, 1, "refreshed");
  assert.equal(w.context.snapshot().kind, "READY", "the name stays while the refresh is on its way");
  await w.answerNext(replied(agency(AGENCY_A, "Northwind Data", "RESTRICTED")));
  assert.deepEqual(w.context.snapshot(), { kind: "READY", agencyId: AGENCY_A, displayName: "Northwind Data", state: "RESTRICTED", role: null });

  w.session.enter({ ...SIGNED_IN });
  await w.answerNext(lost());
  assert.equal(w.context.snapshot().kind, "READY", "a lost answer keeps what was confirmed, as the session does");

  w.session.enter({ ...SIGNED_IN });
  await w.answerNext(refused(403, "NOT_AUTHORIZED"));
  assert.deepEqual(w.context.snapshot(), { kind: "UNAVAILABLE" }, "membership ended: the name goes");
});

test("D-PRIV-1: a listener hears only real changes, and stopping the follower detaches it from the session and aborts what is on its way", async () => {
  const w = world();
  w.session.enter({ kind: "CHECKING" });
  assert.deepEqual(w.seen, [], "LOADING to LOADING is not a change");
  w.session.enter(SIGNED_IN);
  await w.answerNext(replied(agency(AGENCY_A)));
  assert.deepEqual(w.seen, ["READY"]);
  w.session.enter({ ...SIGNED_IN });
  const refresh = w.asked[0];
  assert.ok(refresh);
  w.stop();
  assert.equal(w.session.listening(), 0);
  assert.equal(refresh.signal.aborted, true);
});

test("Order 11 round 2: the role the account button names is the person's own active membership of exactly this agency, and unknown otherwise", () => {
  const member = (agencyId: string, role: "OWNER" | "APPROVER", membershipState: "ACTIVE" | "SUSPENDED") => ({ agencyId, displayName: "x", state: "ACTIVE" as const, version: 1, membershipId: CORRELATION, role, membershipState, permittedActions: ["VIEW" as const] });
  const list = (...items: ReturnType<typeof member>[]) => ({ kind: "REPLY" as const, status: 200, correlationId: CORRELATION, body: { kind: "READ" as const, data: { items } } });
  assert.equal(roleOf(AGENCY_A, list(member(AGENCY_B, "OWNER", "ACTIVE"), member(AGENCY_A, "APPROVER", "ACTIVE"))), "APPROVER");
  assert.equal(roleOf(AGENCY_A, list(member(AGENCY_A, "OWNER", "SUSPENDED"))), null, "a suspended membership names no role");
  assert.equal(roleOf(AGENCY_A, list(member(AGENCY_B, "OWNER", "ACTIVE"))), null, "another agency's role is never borrowed");
  assert.equal(roleOf(AGENCY_A, lost()), null);
  assert.equal(roleOf(AGENCY_A, refused(403, "NOT_AUTHORIZED")), null);
  assert.equal(roleOf(AGENCY_A, null), null, "no read, no role");
});

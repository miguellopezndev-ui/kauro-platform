// B05 L3 ICA: the Intelligence adapter and plan compiler over the real Intelligence core 0.6.0 and Migration Core 3.0.0. The gateway and the
// money admission are the core's labelled SIMULATED ones; the full-dataset validation really runs Migration Core over the fixture input.
// Cases I01, I05, I06, I07 (adapter half), I09, I10, I11 (rounding), I12, I13, I14, I15 (compile half). The durable send and admission are L3m's.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type { Sha256Hex } from "@kauro/contracts";
import { isDomainFailure } from "@kauro/domain";
import { RunLedger } from "@kauro/intelligence-core";
import type { GatewayRequest, GatewayResult, ModelGateway } from "@kauro/intelligence-core";
import { IntelligencePlanCompiler, JournalLedger, ProfileEvidenceMissing, RunIdRefused, centsOfMicros } from "../../src/index.js";
import type { InterpretResult } from "../../src/index.js";
import { AGENCY, ATTEMPT, PROJECT, fixture, interpretRequest, planRequest, type Fixture } from "./intelligence-support.js";

const made: Fixture[] = [];
function make(...args: Parameters<typeof fixture>): Fixture {
  const f = fixture(...args);
  made.push(f);
  return f;
}
after(() => {
  for (const f of made) f.dispose();
});

/** The scripted gateway behind a hook that runs before each analysis (the instant the request would leave the process). */
function hooked(inner: ModelGateway, before: (request: GatewayRequest, journalLength: number) => void): ModelGateway {
  return {
    name: inner.name,
    evidenceClass: inner.evidenceClass,
    analyze: (request: GatewayRequest): Promise<GatewayResult> => {
      before(request, 0);
      return inner.analyze(request);
    },
  };
}

async function run(f: Fixture): Promise<InterpretResult> {
  const manifest = await f.adapter.planCandidates(planRequest(f));
  return f.adapter.interpret(interpretRequest(f, manifest));
}

const journalOf = (f: Fixture) => f.journal.events.get(ATTEMPT) ?? [];

test("I01: appends are buffered and made durable at the barriers in order; a request leaves only after its preparation is durable; the journal read back is the core's ledger", async () => {
  const log: string[] = [];
  const durableAtSend: number[] = [];
  let self: Fixture | undefined;
  const f2 = make({
    runtimeOverrides: {
      gateway: hooked(make().gateway, () => {
        durableAtSend.push(journalOf(self as Fixture).length);
        log.push("SEND");
      }),
    },
  });
  self = f2;
  f2.journal.onAppend = (_run, event) => void log.push(String((event as { kind?: string }).kind));
  const result = await run(f2);
  assert.equal(result.outcome, "COMPILED");
  assert.equal(result.evidenceClass, "EXECUTED_LOCAL");
  const events = journalOf(f2);
  assert.ok(events.length > 3, "the core's whole ledger is durable");
  assert.equal((events[0] as { kind: string }).kind, "RUN_CREATED");
  assert.deepEqual(log.filter((k) => k !== "SEND"), events.map((e) => (e as { kind: string }).kind), "journal order is the ledger order");
  assert.equal(durableAtSend.length, 1);
  assert.ok(log.indexOf("SEND") > log.indexOf("SEND_STARTED") && log.indexOf("SEND_STARTED") > log.indexOf("RESERVED"), "the request leaves only after its reservation and SEND_STARTED are durable");
  assert.ok(log.indexOf("SEND") < log.indexOf("RESPONSE_STORED"), "the response is stored after the send");
  // every event of the journal is the core's own: a fresh ledger over the journal reads back the same events
  const reopened = await JournalLedger.open({
    journal: f2.journal,
    journalRunId: ATTEMPT,
    coreRunId: RunLedger.runIdFor(ATTEMPT, { agencyId: AGENCY, clientId: PROJECT }),
    cancellation: { check: () => Promise.resolve("CONTINUE" as const) },
    deadlinePassed: () => false,
    bounded: (w) => w,
  });
  assert.equal(reopened.durableLength, events.length);
  assert.deepEqual(reopened.read(RunLedger.runIdFor(ATTEMPT, { agencyId: AGENCY, clientId: PROJECT })), events);
});

test("I13: the journal run id is the audit UUID, each request names runIdFor(auditAttemptId, tenant), and a ledger call for another run id is refused", async () => {
  const f = make();
  const result = await run(f);
  assert.equal(result.outcome, "COMPILED");
  assert.deepEqual([...f.journal.events.keys()], [ATTEMPT]);
  const coreRunId = RunLedger.runIdFor(ATTEMPT, { agencyId: AGENCY, clientId: PROJECT });
  assert.equal((journalOf(f)[0] as { runId: string }).runId, coreRunId);
  assert.ok(f.gateway.requests.length >= 1);
  for (const request of f.gateway.requests) assert.equal(request.runId, coreRunId);
  assert.ok(f.admission.admissions.every((a) => a.runId === coreRunId));
  const ledger = await JournalLedger.open({
    journal: f.journal,
    journalRunId: ATTEMPT,
    coreRunId,
    cancellation: { check: () => Promise.resolve("CONTINUE" as const) },
    deadlinePassed: () => false,
    bounded: (w) => w,
  });
  assert.throws(() => ledger.read("run_someone_else"), RunIdRefused);
  assert.throws(() => ledger.append("run_someone_else", journalOf(f)[0] as never, 0), RunIdRefused);
  assert.throws(() => ledger.barrier("run_someone_else", 0, "BEFORE_DISPATCH"), RunIdRefused);
  // another tenant (same audit id) is another core run id
  assert.notEqual(RunLedger.runIdFor(ATTEMPT, { agencyId: AGENCY, clientId: "0192a000-0000-7000-8000-0000000000ff" }), coreRunId);
});

test("I05: a cancellation, a fence, an unreachable authority or the deadline during the run ends FAILED, never COMPILED", async () => {
  for (const revocation of ["CANCELLED", "FENCED", "UNAVAILABLE", "DEADLINE"] as const) {
    let self: Fixture | undefined;
    const f = make({
      runtimeOverrides: {
        gateway: hooked(make().gateway, () => {
          const s = self as Fixture;
          if (revocation === "UNAVAILABLE") s.state.unavailable = true;
          else if (revocation === "DEADLINE") s.clock.advance(3_600_000);
          else s.state.cancellation = revocation;
        }),
      },
    });
    self = f;
    const result = await run(f);
    assert.equal(result.outcome, "FAILED", revocation);
    assert.equal(result.candidateDecisions, null, revocation);
  }
});

test("I06: a hung journal append past the deadline ends FAILED with no dispatch; the prefix that landed stays", async () => {
  const f = make();
  f.journal.onAppend = (_run, _event, index) => (index === 1 ? "HANG" : undefined);
  const result = await run(f);
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.candidateDecisions, null);
  assert.equal(f.gateway.requests.length, 0, "nothing was dispatched");
  assert.equal(f.admission.view().chargedMicros, 0, "nothing was spent");
  assert.equal(journalOf(f).length, 1, "the event that landed before the hang stays");
});

test("I06: an interpretation deadline already passed at entry ends FAILED before any read, reservation or dispatch", async () => {
  const f = make();
  const manifest = await f.adapter.planCandidates(planRequest(f));
  const result = await f.adapter.interpret(interpretRequest(f, manifest, { interpretationDeadlineAt: new Date(f.clock.nowMs() - 1).toISOString() as never }));
  assert.equal(result.outcome, "FAILED");
  assert.equal(f.journal.appends, 0);
  assert.equal(f.admission.admissions.length, 0);
  assert.equal(f.gateway.requests.length, 0);
});

test("I12: a refused barrier is sticky: the prefix stays, a later append, barrier or flush is refused, and a late continuation is dropped", async () => {
  const f = make();
  f.journal.onAppend = (_run, _event, index) => (index === 2 ? "REFUSE" : undefined);
  const result = await run(f);
  assert.equal(result.outcome, "FAILED");
  assert.equal(f.gateway.requests.length, 0, "no dispatch after a refused barrier");
  assert.equal(journalOf(f).length, 2, "the landed prefix stays");
  // the same stickiness at the ledger itself
  const coreRunId = RunLedger.runIdFor(ATTEMPT, { agencyId: AGENCY, clientId: PROJECT });
  const journal = new (Object.getPrototypeOf(f.journal).constructor as new () => typeof f.journal)();
  let state: "CONTINUE" | "CANCELLED" = "CONTINUE";
  const ledger = await JournalLedger.open({ journal, journalRunId: ATTEMPT, coreRunId, cancellation: { check: () => Promise.resolve(state) }, deadlinePassed: () => false, bounded: (w) => w });
  const event = { kind: "RUN_CREATED", at: "2026-10-11T12:00:00.000Z", runId: coreRunId } as never;
  assert.deepEqual(ledger.append(coreRunId, event, 0), { ok: true, length: 1 });
  state = "CANCELLED";
  const refused = await ledger.barrier(coreRunId, 1, "BEFORE_DISPATCH");
  assert.deepEqual(refused, { ok: false, reason: "CANCELLED" });
  assert.equal(journal.appends, 0, "a barrier refused before the flush wrote nothing");
  state = "CONTINUE";
  assert.deepEqual(await ledger.barrier(coreRunId, 1, "AFTER_RESULT"), { ok: false, reason: "CANCELLED" }, "the refusal stays after the channel recovers");
  assert.equal(ledger.append(coreRunId, event, 1).ok, false, "a later append is refused");
  assert.equal(journal.appends, 0);
});

test("I12: a journal that throws (a newer step or a stale fence, KA080) refuses the barrier and the run ends FAILED", async () => {
  const f = make();
  f.journal.onAppend = (_run, _event, index) => (index === 1 ? "THROW" : undefined);
  const result = await run(f);
  assert.equal(result.outcome, "FAILED");
  assert.equal(f.gateway.requests.length, 0);
  assert.equal(f.admission.view().chargedMicros, 0);
});

test("I14: a missing or hash-mismatched profile fails PROFILE_EVIDENCE_MISSING before any reservation", async () => {
  const f = make();
  const manifest = await f.adapter.planCandidates(planRequest(f));
  const key = `${AGENCY}|SOURCE_PROFILE|${f.profile.profileHash}`;
  const stored = f.documents.documents.get(key);
  // a profile stored under a hash it does not have
  f.documents.documents.set(key, { ...(stored as object), tampered: true });
  await assert.rejects(f.adapter.planCandidates(planRequest(f)), (e: unknown) => e instanceof ProfileEvidenceMissing && e.what === "SOURCE_PROFILE");
  assert.equal((await f.adapter.interpret(interpretRequest(f, manifest))).outcome, "FAILED");
  // a profile that is not there at all
  f.documents.documents.delete(key);
  await assert.rejects(f.adapter.planCandidates(planRequest(f)), (e: unknown) => e instanceof ProfileEvidenceMissing);
  assert.equal((await f.adapter.interpret(interpretRequest(f, manifest))).outcome, "FAILED");
  // a target contract that is named and not stored
  f.documents.documents.set(key, stored);
  await assert.rejects(f.adapter.planCandidates({ ...planRequest(f), targetContractHash: "a".repeat(64) as Sha256Hex }), (e: unknown) => e instanceof ProfileEvidenceMissing && e.what === "TARGET_CONTRACT");
  assert.equal(f.journal.appends, 0);
  assert.equal(f.admission.admissions.length, 0);
  assert.equal(f.gateway.requests.length, 0);
});

test("T04/I07: planCandidates plans a complete manifest with no dispatch or spend; a second interpret of the same attempt compiles the stored response before any new dispatch", async () => {
  const f = make();
  const manifest = await f.adapter.planCandidates(planRequest(f));
  assert.equal(f.gateway.calls, 0);
  assert.equal(f.admission.admissions.length, 0);
  assert.equal(f.journal.appends, 0);
  assert.equal((manifest.document as { truncated: boolean }).truncated, false);
  assert.ok((manifest.document as { produced: number }).produced > 0);
  const first = await f.adapter.interpret(interpretRequest(f, manifest));
  assert.equal(first.outcome, "COMPILED");
  const sends = f.gateway.requests.length;
  const admissions = f.admission.admissions.length;
  const second = await f.adapter.interpret(interpretRequest(f, manifest));
  assert.equal(second.outcome, "COMPILED");
  assert.equal(f.gateway.requests.length, sends, "no new dispatch");
  assert.equal(f.admission.admissions.length, admissions, "nothing reserved twice");
  assert.deepEqual(second.candidateDecisions, first.candidateDecisions, "the same draft from the stored response");
  // no funded room and no reservation: nothing is dispatched
  const poor = make({ fundedMicros: 0 });
  const poorResult = await run(poor);
  assert.notEqual(poorResult.outcome, "COMPILED");
  assert.equal(poor.gateway.requests.length, 0);
});

test("I11: a micro-charge rounds up to whole cents: 1 micro reserves 1 cent, 10000k+1 micros k+1 cents", () => {
  assert.equal(centsOfMicros(0), 0);
  assert.equal(centsOfMicros(1), 1);
  assert.equal(centsOfMicros(10_000), 1);
  assert.equal(centsOfMicros(10_001), 2);
  assert.equal(centsOfMicros(30_000), 3);
  assert.equal(centsOfMicros(30_001), 4);
});

test("I09: the compiler rejects anything that is not a validated system draft of this adapter as MALFORMED_PATCH", async () => {
  const f = make();
  const compiler = new IntelligencePlanCompiler({ documents: f.documents });
  const result = await run(f);
  assert.equal(result.outcome, "COMPILED");
  const rejected = { kind: "REJECTED", reason: "MALFORMED_PATCH" };
  for (const bad of [null, undefined, {}, "x", { kind: "OTHER" }, { ...(result.candidateDecisions as object), kind: "OTHER" }]) {
    assert.deepEqual(await compiler.compile(bad, null), rejected);
  }
  // a revision's patch is the patch compiler's, not this port's
  assert.deepEqual(await compiler.compile(result.candidateDecisions, {} as never), rejected);
  // a draft that is not validated, or has no configuration
  const draft = (result.candidateDecisions as { draft: Record<string, unknown> }).draft;
  for (const changed of [{ configuration: null }, { status: "NOT_DRAFTABLE" }, { validation: { status: "NOT_RUN", blockedDestinations: [], refusal: null } }, { fullValidation: null }]) {
    const decisions = { ...(result.candidateDecisions as object), draft: { ...draft, ...changed } };
    assert.deepEqual(await compiler.compile(decisions, null), rejected, JSON.stringify(Object.keys(changed)));
  }
  // the profile the draft was made from is gone
  f.documents.documents.clear();
  assert.deepEqual(await compiler.compile(result.candidateDecisions, null), rejected);
  assert.equal(f.documents.bindings.size, 0);
});

test("I10/I15: a compiled plan is stored with its binding under the platform's own digest; a hash the core does not reproduce is INTEGRITY_FAILURE and binds nothing", async () => {
  const f = make();
  const compiler = new IntelligencePlanCompiler({ documents: f.documents });
  const result = await run(f);
  const compiled = await compiler.compile(result.candidateDecisions, null);
  assert.equal(compiled.kind, "COMPILED");
  if (compiled.kind !== "COMPILED") return;
  assert.equal(compiled.bodyHash, structuredDigest(DOMAINS.PLAN_BODY, 1, compiled.body), "the platform recomputes the digest, never takes the core's");
  assert.ok(compiled.body.mappings.length > 0);
  assert.equal(compiled.body.targetContractHash.length, 64);
  // the binding: planHash -> the configuration document and the core-native config hash the validation named
  const binding = f.documents.bindings.get(compiled.bodyHash);
  assert.ok(binding !== undefined, "a draft without its binding does not exist");
  assert.equal(binding.coreConfigHash, f.validations[0]?.evidence.coreConfigHash, "the core-native hash is stored verbatim");
  // a replayed compile is byte-identical
  const again = await compiler.compile(result.candidateDecisions, null);
  assert.deepEqual(again, compiled);
  assert.equal(f.documents.bindings.size, 1);
  // a core-native hash its own loader does not reproduce
  const tampered = structuredClone(result.candidateDecisions) as { draft: { fullValidation: { evidence: { coreConfigHash: string } } } };
  tampered.draft.fullValidation.evidence.coreConfigHash = "b".repeat(64);
  const failure = await compiler.compile(tampered, null).then(() => null, (e: unknown) => e);
  assert.ok(isDomainFailure(failure) && failure.code === "INTEGRITY_FAILURE", String(failure));
  assert.equal(f.documents.bindings.size, 1, "nothing new is bound");
});

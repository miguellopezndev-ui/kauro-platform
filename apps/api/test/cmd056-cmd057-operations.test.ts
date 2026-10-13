// CMD056 RecordIncident (POST /api/v1/operations/incidents, OPERATIONS_SERVICE_OR_OWNER), CMD057 AuthorizeRecovery (POST
// /api/v1/operations/recoveries, KAURO_OWNER with a fresh step-up) and CMD059 RestrictCapability as the operations service — package B18
// (registry commands CMD056, CMD057; cases CMD056-OK, CMD056-DENY, CMD056-RACE, CMD057-OK, CMD057-DENY, CMD057-RACE; decision B18-OPS-1).
// The real routes, the corporate owner authorizer, B06's step-up verifier, the operations service as a verified service identity running
// in the commission group's SERVICE units of work, and PostgreSQL 17 through the runtime login roles; the superuser only reads and builds
// the restore-candidate and capability fixtures (the platform prepares a candidate; no command here does). The registry lists no events
// for these commands, so there is no consumer fan-out to test. Interleavings are held at named points; nothing sleeps.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CapabilityRestrictionView, IncidentView, RecoveryAuthorizationView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { ServiceCrash, commissionToken, rows, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { asPerson } from "./sellers-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, sha, waitForApiLockWait, type Reply } from "./support.js";

let sw: StatementsWorld;
invariantsAfterEach(() => sw.h.oracle);
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const incidentsUrl = "/api/v1/operations/incidents";
const recoveriesUrl = "/api/v1/operations/recoveries";
const restrictUrl = (capabilityId: string): string => `/api/v1/operations/capabilities/${capabilityId}/restrict`;
const ownerId = (): UserId => sw.owner.userId as UserId;
const opsToken = (): string => commissionToken(sw, "operations-service");

async function record(body: Record<string, unknown>, options: { readonly token?: string | null; readonly key?: string } = {}): Promise<Reply> {
  return call(sw.w, { url: incidentsUrl, token: options.token === undefined ? sw.owner.token : options.token, agency: null, key: options.key ?? freshKey("cmd056"), body });
}
async function authorize(body: Record<string, unknown>, options: { readonly token?: string | null; readonly key?: string } = {}): Promise<Reply> {
  return call(sw.w, { url: recoveriesUrl, token: options.token === undefined ? sw.owner.token : options.token, agency: null, key: options.key ?? freshKey("cmd057"), body });
}
async function restrict(capabilityId: string, body: Record<string, unknown>, options: { readonly token?: string | null; readonly key?: string } = {}): Promise<Reply> {
  return call(sw.w, { url: restrictUrl(capabilityId), token: options.token === undefined ? sw.owner.token : options.token, agency: null, key: options.key ?? freshKey("cmd059"), body });
}

const incidentBody = (label: string, severity = "S2") => ({ severity, affectedScopeRefs: [`provider:${label}`, "route:checkout"], summary: `Monitoring evidence for ${label}` });

type IncidentRow = { incident_id: string; kind: string; severity: string | null; state: string; communication_state: string; affected_scopes: string[]; recorded_by_user_id: string | null; recorded_by_service: string | null; started_at: Date; review_at: Date };
const incidentRow = async (incidentId: string): Promise<IncidentRow | undefined> => (await rows<IncidentRow>(sw, "SELECT * FROM kauro.incidents WHERE incident_id = $1", [incidentId]))[0];
const responsibilityRows = async (incidentId: string) => rows<{ responsibility: string; state: string; due_at: Date }>(sw, "SELECT responsibility, state, due_at FROM kauro.incident_responsibilities WHERE incident_id = $1 ORDER BY responsibility", [incidentId]);
const incidentCount = async (): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.incidents"))[0]!.n);

/** A restore candidate the platform PREPARED (the control plane's write; no command prepares one). */
async function candidate(label: string): Promise<{ readonly candidateId: string; readonly deletionJournalHash: string }> {
  const candidateId = ids.next();
  const deletionJournalHash = sha(`deletion-journal-${label}`);
  await sw.h.oracle.query("INSERT INTO kauro.restore_candidates (candidate_id, state, plan_hash, deletion_journal_hash) VALUES ($1, 'PREPARED', $2, $3)", [candidateId, sha(`plan-${label}`), deletionJournalHash]);
  return { candidateId, deletionJournalHash };
}
type CandidateRow = { state: string; revision: number };
const candidateRow = async (candidateId: string): Promise<CandidateRow> => (await rows<CandidateRow>(sw, "SELECT state, revision FROM kauro.restore_candidates WHERE candidate_id = $1", [candidateId]))[0]!;
const recoveryRows = async (candidateId: string) =>
  rows<{ recovery_id: string; deletion_journal_hash: string; authorization_ref: string; authorized_by_user_id: string }>(sw, "SELECT recovery_id, deletion_journal_hash, authorization_ref, authorized_by_user_id FROM kauro.recoveries WHERE candidate_id = $1", [candidateId]);
const recoveryBody = async (c: { candidateId: string; deletionJournalHash: string }, proof?: string) => ({ restoreCandidateRef: c.candidateId, deletionJournalHash: c.deletionJournalHash, authorizationRef: proof ?? (await sw.w.stepUp(sw.owner)) });

/** A TOOL capability (no mode) walked to AVAILABLE_LIMITED along the listed edges, as the control plane does. */
async function capability(label: string): Promise<string> {
  const id = ids.next();
  await sw.h.oracle.query(
    `INSERT INTO kauro.capabilities (capability_id, version, kind, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
     VALUES ($1, $2, 'TOOL', 'DESIGN', $3, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
    [id, `B18-ops-${label}`, sha(`profile-ops-${label}`)],
  );
  await sw.h.publishCapability(id as never, "AVAILABLE_LIMITED");
  return id;
}
const capabilityRow = async (capabilityId: string) => (await rows<{ state: string; revision: number }>(sw, "SELECT state, revision FROM kauro.capabilities WHERE capability_id = $1", [capabilityId]))[0]!;
const restrictionRows = async (capabilityId: string) => rows<{ incident_ref: string; prior_state: string; recorded_by_user_id: string | null; recorded_by_service: string | null }>(sw, "SELECT incident_ref, prior_state, recorded_by_user_id, recorded_by_service FROM kauro.capability_restrictions WHERE capability_id = $1", [capabilityId]);

// --- CMD056 ----------------------------------------------------------------------------------------------------------------------------

test("CMD056-OK: the owner records an actual incident — 201 DETECTED with its open responsibilities and the database's checkpoint of the severity (S1 one hour, S4 72 hours), S1 and S2 with the communication review required; a false positive is recorded CLOSED with none; the operations service records one as itself", async () => {
  const s2 = completed<IncidentView>(await record(incidentBody("ok-s2", "S2")), 201);
  assert.deepEqual([s2.data.severity, s2.data.state, s2.data.communicationState, s2.data.openResponsibilities], ["S2", "DETECTED", "REVIEW_REQUIRED", ["CONTAINMENT", "RECOVERY", "COMMUNICATION"]]);
  assert.equal(s2.version, 1);
  const row = (await incidentRow(s2.data.incidentId))!;
  assert.deepEqual([row.kind, row.severity, row.state, row.recorded_by_user_id, row.recorded_by_service, row.affected_scopes], ["ACTUAL", "S2", "DETECTED", ownerId(), null, ["provider:ok-s2", "route:checkout"]]);
  assert.equal(row.review_at.getTime() - row.started_at.getTime(), 4 * 3_600_000, "S2: the checkpoint is four hours from the database's instant");
  assert.equal(s2.data.startedAt, row.started_at.toISOString());
  assert.equal(s2.data.reviewAt, row.review_at.toISOString());
  assert.deepEqual((await responsibilityRows(s2.data.incidentId)).map((r) => [r.responsibility, r.state]), [["COMMUNICATION", "OPEN"], ["CONTAINMENT", "OPEN"], ["RECOVERY", "OPEN"]]);

  const s1 = completed<IncidentView>(await record(incidentBody("ok-s1", "S1")), 201);
  const s1Row = (await incidentRow(s1.data.incidentId))!;
  assert.equal(s1Row.review_at.getTime() - s1Row.started_at.getTime(), 3_600_000);
  const s4 = completed<IncidentView>(await record(incidentBody("ok-s4", "S4")), 201);
  const s4Row = (await incidentRow(s4.data.incidentId))!;
  assert.equal(s4Row.review_at.getTime() - s4Row.started_at.getTime(), 72 * 3_600_000);
  assert.deepEqual([s4.data.communicationState, s4.data.openResponsibilities], ["NOT_REQUIRED", ["CONTAINMENT", "RECOVERY"]], "S3 and S4 need no communication review");
  assert.deepEqual((await responsibilityRows(s4.data.incidentId)).map((r) => [r.responsibility, r.state]), [["COMMUNICATION", "NOT_REQUIRED"], ["CONTAINMENT", "OPEN"], ["RECOVERY", "OPEN"]]);

  // a monitoring false positive is recorded as such: CLOSED at once, no severity, no responsibility
  const fp = completed<IncidentView>(await record(incidentBody("ok-fp", "FALSE_POSITIVE")), 201);
  assert.deepEqual([fp.data.severity, fp.data.state, fp.data.openResponsibilities], ["FALSE_POSITIVE", "CLOSED", []]);
  const fpRow = (await incidentRow(fp.data.incidentId))!;
  assert.deepEqual([fpRow.kind, fpRow.severity, fpRow.state], ["FALSE_POSITIVE", null, "CLOSED"]);
  assert.deepEqual(await responsibilityRows(fp.data.incidentId), []);

  // the operations service is the second principal: recorded as itself, journaled under its identity with no agency
  const key = freshKey("cmd056-service");
  const byService = completed<IncidentView>(await record(incidentBody("ok-service", "S3"), { token: opsToken(), key }), 201);
  const serviceRow = (await incidentRow(byService.data.incidentId))!;
  assert.deepEqual([serviceRow.recorded_by_user_id, serviceRow.recorded_by_service, serviceRow.severity], [null, "operations-service", "S3"]);
  const journal = await sw.w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "incident", id: byService.data.incidentId });

  // nothing resolves an incident: no runtime role can move one (the registry: an incident is never fabricated as a resolved outage)
  const moved = await asPerson(sw.h, ownerId(), (q) => q.query("UPDATE kauro.incidents SET state = 'CLOSED' WHERE incident_id = $1", [s2.data.incidentId]).then(() => "moved", (e: { code?: string }) => e.code ?? "refused"));
  assert.notEqual(moved, "moved");
  assert.equal((await incidentRow(s2.data.incidentId))!.state, "DETECTED");
});

test("CMD056-DENY: an agency member and a stranger are refused (403 CORPORATE_ROLE_MISSING), the commission and finance services and another environment's operations service are wrong service identities, no credential is 401; then one invalid body at a time — nothing is written", async () => {
  const { w } = sw;
  const before = await incidentCount();
  const member = await w.person("cmd056-deny-member");
  await w.h.addMember(w.A, member.userId, "OWNER");
  const stranger = await w.person("cmd056-deny-stranger");
  const personDenials = (await w.securityEvents("CMD056")).length;
  assert.equal(outcome(w, await record(incidentBody("deny"), { token: member.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "an agency OWNER is not the corporate owner");
  assert.equal(outcome(w, await record(incidentBody("deny"), { token: stranger.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w.securityEvents("CMD056")).slice(personDenials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);

  // the technical role is the operations service's alone; the denial is a durable fact of the service stream
  const serviceDenials = (await w.securityEvents("CMD056")).length;
  assert.equal(outcome(w, await record(incidentBody("deny"), { token: commissionToken(sw, "commission-service") })), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.equal(outcome(w, await record(incidentBody("deny"), { token: commissionToken(sw, "finance-service") })), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.equal(outcome(w, await record(incidentBody("deny"), { token: commissionToken(sw, "operations-service", "LIVE") })), "403 NOT_AUTHORIZED SERVICE_ENVIRONMENT_MISMATCH");
  assert.deepEqual((await w.securityEvents("CMD056")).slice(serviceDenials).map((f) => [f.outcome, f.reason]), [["DENY", "SERVICE_NOT_PERMITTED"], ["DENY", "SERVICE_NOT_PERMITTED"], ["DENY", "SERVICE_ENVIRONMENT_MISMATCH"]]);
  assert.equal(outcome(w, await record(incidentBody("deny"), { token: null })), "401 AUTHENTICATION_REQUIRED -");

  // the closed body: a severity outside the closed list, no scope, a scope that is not a safe reference, an empty summary, an unknown member
  for (const [what, body] of [
    ["unknown severity", { ...incidentBody("deny"), severity: "S9" }],
    ["resolved is not an intake", { ...incidentBody("deny"), severity: "RESOLVED" }],
    ["no scope", { ...incidentBody("deny"), affectedScopeRefs: [] }],
    ["a scope that is not a safe reference", { ...incidentBody("deny"), affectedScopeRefs: ["customer data dump"] }],
    ["an empty summary", { ...incidentBody("deny"), summary: "" }],
    ["a state member", { ...incidentBody("deny"), state: "CLOSED" }],
  ] as const) assert.equal((await record(body)).status, 400, what);
  assert.equal(await incidentCount(), before, "every refusal wrote nothing");
});

test("CMD056-RACE: an identical retry replays the 201, the same key with another body is 409 IDEMPOTENCY_CONFLICT, and a crash before COMMIT leaves no incident — for the owner and for the operations service", async () => {
  const { w } = sw;
  for (const as of ["owner", "service"] as const) {
    const token = as === "owner" ? sw.owner.token : opsToken();
    const key = freshKey(`cmd056-race-${as}`);
    const body = incidentBody(`race-${as}`, "S3");
    const first = await record(body, { token, key });
    completed<IncidentView>(first, 201);
    const count = await incidentCount();
    const replay = await record(body, { token, key });
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.text, replayTextOf(first));
    assert.equal(await incidentCount(), count, "the replay recorded nothing a second time");
    assert.equal(outcome(w, await record({ ...body, severity: "S1" }, { token, key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");

    // a crash at the intent/commit boundary: the incident was written and never committed
    const crashKey = freshKey(`cmd056-crash-${as}`);
    const crashBody = incidentBody(`crash-${as}`, "S2");
    const before = await incidentCount();
    if (as === "owner") w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
    else sw.serviceHolds.arm("CMD056", { fail: new ServiceCrash("before COMMIT") });
    assert.equal(outcome(w, await record(crashBody, { token, key: crashKey })), "500 INTERNAL_ERROR -");
    assert.equal(await incidentCount(), before, "nothing survived the crash");
    assert.equal(await w.journal(crashKey), null);
    completed<IncidentView>(await record(crashBody, { token, key: crashKey }), 201);
    assert.equal(await incidentCount(), before + 1);
  }
});

// --- CMD057 ----------------------------------------------------------------------------------------------------------------------------

test("CMD057-OK: the owner with a fresh step-up authorizes a PREPARED restore candidate for its own deletion journal hash — 200 AUTHORIZED at the next candidate revision, one recovery row naming the owner, the proof and the hash, the journal and the step-up fact committed with it", async () => {
  const { w } = sw;
  const c = await candidate("ok");
  const body = await recoveryBody(c);
  const key = freshKey("cmd057-ok");
  const events = (await w.securityEvents("CMD057")).length;
  const done = completed<RecoveryAuthorizationView>(await authorize(body, { key }), 200);
  assert.deepEqual([done.data.restoreCandidateRef, done.data.state, done.data.version], [c.candidateId, "AUTHORIZED", 2]);
  assert.equal(done.version, 2);
  assert.deepEqual(await candidateRow(c.candidateId), { state: "AUTHORIZED", revision: 2 });
  const recovery = await recoveryRows(c.candidateId);
  assert.deepEqual(recovery.map((r) => [r.recovery_id, r.deletion_journal_hash, r.authorization_ref, r.authorized_by_user_id]), [[done.data.recoveryId, c.deletionJournalHash, body.authorizationRef, ownerId()]]);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 200, kind: "recovery", id: done.data.recoveryId });
  assert.deepEqual((await w.securityEvents("CMD057")).slice(events).map((f) => [f.outcome, f.reason]), [["ALLOW", "STEP_UP_FRESH"]]);
  await assert.rejects(sw.h.oracle.query("DELETE FROM kauro.recoveries WHERE candidate_id = $1", [c.candidateId]), "a recovery is append-only");
});

test("CMD057-DENY: an agency member and a stranger are refused (403), a service identity is no owner, no fresh step-up is ASSURANCE_REQUIRED; then one missing prerequisite at a time — an unknown candidate, another deletion journal hash, an already authorized candidate — nothing is written", async () => {
  const { w } = sw;
  const c = await candidate("deny");
  const untouched = async (what: string) => {
    assert.deepEqual(await candidateRow(c.candidateId), { state: "PREPARED", revision: 1 }, `${what}: the candidate is as it was`);
    assert.deepEqual(await recoveryRows(c.candidateId), [], `${what}: no recovery was written`);
  };
  const member = await w.person("cmd057-deny-member");
  await w.h.addMember(w.A, member.userId, "OWNER");
  const stranger = await w.person("cmd057-deny-stranger");
  const denials = (await w.securityEvents("CMD057")).length;
  assert.equal(outcome(w, await authorize(await recoveryBody(c), { token: member.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "an agency OWNER is not the corporate owner");
  assert.equal(outcome(w, await authorize(await recoveryBody(c), { token: stranger.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w.securityEvents("CMD057")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);
  assert.equal((await authorize(await recoveryBody(c), { token: opsToken() })).status, 401, "the operations service cannot authorize a recovery: the route has one principal, the owner");
  assert.equal(outcome(w, await authorize(await recoveryBody(c), { token: null })), "401 AUTHENTICATION_REQUIRED -");
  await untouched("wrong role");

  // the step-up: a stale proof and another person's proof authorize nothing
  assert.equal(outcome(w, await authorize(await recoveryBody(c, await w.stepUp(sw.owner, "STALE")))), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  assert.equal(outcome(w, await authorize(await recoveryBody(c, await w.stepUp(w.owner)))), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  await untouched("step-up");

  // one missing prerequisite at a time
  assert.equal(outcome(w, await authorize({ ...(await recoveryBody(c)), restoreCandidateRef: ids.next() })), "404 NOT_FOUND -");
  assert.equal(outcome(w, await authorize({ ...(await recoveryBody(c)), deletionJournalHash: sha("another-journal") })), "409 PRECONDITION_FAILED RECOVERY_DELETION_JOURNAL_MISMATCH");
  assert.equal((await authorize({ ...(await recoveryBody(c)), extra: true })).status, 400, "a closed body");
  assert.equal((await authorize({ restoreCandidateRef: c.candidateId, deletionJournalHash: c.deletionJournalHash })).status, 400, "the proof is required");
  await untouched("every refusal");

  // the correct request is accepted, then the candidate is spent: a second authorization is a typed refusal, never a second recovery
  completed<RecoveryAuthorizationView>(await authorize(await recoveryBody(c)), 200);
  const again = await authorize(await recoveryBody(c));
  assert.equal(outcome(w, again), "409 PRECONDITION_FAILED RECOVERY_CANDIDATE_NOT_PREPARED");
  assert.deepEqual(asProblem(w, again).current, { version: 2, state: "AUTHORIZED" });
  assert.equal((await recoveryRows(c.candidateId)).length, 1);
  // the database holds the same lines: a request session cannot authorize twice nor change what the candidate prepared
  const forged = await asPerson(sw.h, ownerId(), (q) => q.query("UPDATE kauro.restore_candidates SET deletion_journal_hash = $2 WHERE candidate_id = $1", [c.candidateId, sha("forged")]).then(() => "moved", (e: { code?: string }) => e.code ?? "refused"));
  assert.notEqual(forged, "moved");
});

test("CMD057-RACE: an identical retry replays the 200, the same key with another candidate is 409 IDEMPOTENCY_CONFLICT, two authorizations of one candidate yield one recovery and one 409 RECOVERY_CANDIDATE_NOT_PREPARED with the wait observed, and a crash before COMMIT leaves the candidate PREPARED", async () => {
  const { w } = sw;
  const c = await candidate("race");
  const key = freshKey("cmd057-race");
  const body = await recoveryBody(c);
  const first = await authorize(body, { key });
  completed<RecoveryAuthorizationView>(first, 200);
  const replay = await authorize(body, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await recoveryRows(c.candidateId)).length, 1, "the replay authorized nothing a second time");
  const other = await candidate("race-other");
  assert.equal(outcome(w, await authorize(await recoveryBody(other), { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await candidateRow(other.candidateId)).state, "PREPARED");

  // two authorizations of one candidate: the first holds the candidate row until its commit; the second waits, then reads AUTHORIZED
  const racing = await candidate("race-two");
  const hold = w.holds.arm("journal.commit");
  const winner = authorize(await recoveryBody(racing));
  await hold.reached;
  const loser = authorize(await recoveryBody(racing));
  try {
    await waitForApiLockWait(w, "FROM kauro.restore_candidates");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  completed<RecoveryAuthorizationView>(won, 200);
  assert.equal(outcome(w, lost), "409 PRECONDITION_FAILED RECOVERY_CANDIDATE_NOT_PREPARED");
  assert.deepEqual(asProblem(w, lost).current, { version: 2, state: "AUTHORIZED" });
  assert.equal((await recoveryRows(racing.candidateId)).length, 1, "one recovery");

  // a crash at the intent/commit boundary: the authorization was written and never committed
  const crashing = await candidate("race-crash");
  const crashKey = freshKey("cmd057-crash");
  const crashBody = await recoveryBody(crashing);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await authorize(crashBody, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual([await candidateRow(crashing.candidateId), await recoveryRows(crashing.candidateId)], [{ state: "PREPARED", revision: 1 }, []]);
  assert.equal(await w.journal(crashKey), null);
  completed<RecoveryAuthorizationView>(await authorize(crashBody, { key: crashKey }), 200);
  assert.equal((await candidateRow(crashing.candidateId)).state, "AUTHORIZED");
});

// --- CMD059 as the operations service ------------------------------------------------------------------------------------------------------

test("CMD059-OK (operations service): the operations service restricts an offered capability as itself — 200 SUSPENDED, the restriction evidence naming the service and not a person, journaled under its identity", async () => {
  const id = await capability("service-ok");
  const incident = completed<IncidentView>(await record(incidentBody("service-ok", "S1"), { token: opsToken() }), 201);
  const key = freshKey("cmd059-service");
  const done = completed<CapabilityRestrictionView>(await restrict(id, { expectedVersion: 1, incidentRef: incident.data.incidentId }, { token: opsToken(), key }), 200);
  assert.deepEqual([done.data.capabilityId, done.data.version, done.data.state, done.data.priorState, done.data.incidentRef], [id, 2, "SUSPENDED", "AVAILABLE_LIMITED", incident.data.incidentId]);
  assert.deepEqual(await capabilityRow(id), { state: "SUSPENDED", revision: 2 });
  assert.deepEqual(await restrictionRows(id), [{ incident_ref: incident.data.incidentId, prior_state: "AVAILABLE_LIMITED", recorded_by_user_id: null, recorded_by_service: "operations-service" }]);
  const journal = await sw.w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 200, kind: "capability", id });
});

test("CMD059-DENY (operations service): the commission and finance services are wrong service identities (403), then a stale version, an already SUSPENDED and an unknown capability are typed refusals — nothing is written; the service can move a capability only to SUSPENDED", async () => {
  const { w } = sw;
  const id = await capability("service-deny");
  const incident = ids.next();
  const denials = (await w.securityEvents("CMD059")).length;
  assert.equal(outcome(w, await restrict(id, { expectedVersion: 1, incidentRef: incident }, { token: commissionToken(sw, "commission-service") })), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.equal(outcome(w, await restrict(id, { expectedVersion: 1, incidentRef: incident }, { token: commissionToken(sw, "finance-service") })), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.equal(outcome(w, await restrict(id, { expectedVersion: 1, incidentRef: incident }, { token: commissionToken(sw, "operations-service", "LIVE") })), "403 NOT_AUTHORIZED SERVICE_ENVIRONMENT_MISMATCH");
  assert.deepEqual((await w.securityEvents("CMD059")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "SERVICE_NOT_PERMITTED"], ["DENY", "SERVICE_NOT_PERMITTED"], ["DENY", "SERVICE_ENVIRONMENT_MISMATCH"]]);
  assert.deepEqual([await capabilityRow(id), await restrictionRows(id)], [{ state: "AVAILABLE_LIMITED", revision: 1 }, []]);

  assert.equal(outcome(w, await restrict(id, { expectedVersion: 9, incidentRef: incident }, { token: opsToken() })), "409 STALE_VERSION -");
  assert.equal(outcome(w, await restrict(ids.next(), { expectedVersion: 1, incidentRef: incident }, { token: opsToken() })), "404 NOT_FOUND -");
  assert.equal((await restrict(id, { expectedVersion: 1 }, { token: opsToken() })).status, 400, "an incident is required");
  assert.deepEqual([await capabilityRow(id), await restrictionRows(id)], [{ state: "AVAILABLE_LIMITED", revision: 1 }, []]);
  completed<CapabilityRestrictionView>(await restrict(id, { expectedVersion: 1, incidentRef: incident }, { token: opsToken() }), 200);
  const again = await restrict(id, { expectedVersion: 2, incidentRef: ids.next() }, { token: opsToken() });
  assert.equal(outcome(w, again), "409 PRECONDITION_FAILED CAPABILITY_NOT_RESTRICTABLE");
  assert.equal((await restrictionRows(id)).length, 1);

});

test("CMD059-RACE (operations service): an identical retry replays the 200, the same key with another incident is 409 IDEMPOTENCY_CONFLICT, two restrictions on one expectedVersion yield one restriction and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the capability offered", async () => {
  const { w } = sw;
  const id = await capability("service-race");
  const key = freshKey("cmd059-service-race");
  const body = { expectedVersion: 1, incidentRef: ids.next() };
  const first = await restrict(id, body, { token: opsToken(), key });
  completed<CapabilityRestrictionView>(first, 200);
  const replay = await restrict(id, body, { token: opsToken(), key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await restrictionRows(id)).length, 1, "the replay restricted nothing a second time");
  assert.equal(outcome(w, await restrict(id, { ...body, incidentRef: ids.next() }, { token: opsToken(), key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");

  // two restrictions on one expectedVersion, the owner's and the service's: the first holds the capability row until its commit
  const racing = await capability("service-race-two");
  const hold = sw.serviceHolds.arm("CMD059");
  const winner = restrict(racing, { expectedVersion: 1, incidentRef: ids.next() }, { token: opsToken() });
  await hold.reached;
  const loser = restrict(racing, { expectedVersion: 1, incidentRef: ids.next() });
  try {
    await waitForApiLockWait(w, "FROM kauro.capabilities");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  completed<CapabilityRestrictionView>(won, 200);
  assert.equal(outcome(w, lost), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, lost).current, { version: 2, state: "SUSPENDED" });
  assert.equal((await restrictionRows(racing)).length, 1, "one restriction");

  const crashing = await capability("service-race-crash");
  const crashKey = freshKey("cmd059-service-crash");
  const crashBody = { expectedVersion: 1, incidentRef: ids.next() };
  sw.serviceHolds.arm("CMD059", { fail: new ServiceCrash("before COMMIT") });
  assert.equal(outcome(w, await restrict(crashing, crashBody, { token: opsToken(), key: crashKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual([await capabilityRow(crashing), await restrictionRows(crashing)], [{ state: "AVAILABLE_LIMITED", revision: 1 }, []]);
  completed<CapabilityRestrictionView>(await restrict(crashing, crashBody, { token: opsToken(), key: crashKey }), 200);
  assert.equal((await capabilityRow(crashing)).state, "SUSPENDED");
});

// CMD058 ChangeCapability (POST /api/v1/operations/capabilities/{capabilityId}/versions, KAURO_OWNER) and CMD059 RestrictCapability
// (POST /api/v1/operations/capabilities/{capabilityId}/restrict) — package B18, gate G-RELEASE (registry commands CMD058, CMD059; cases
// CMD058-OK, CMD058-DENY, CMD058-RACE, CMD059-OK, CMD059-DENY, CMD059-RACE). The real route, the corporate owner authorizer and
// PostgreSQL 17 through the runtime login roles; the superuser only reads and builds the capability fixtures (a capability is born DESIGN
// and walks the listed edges: the fixtures use the harness publication path).
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CapabilityRestrictionView, CapabilityVersionView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { asPerson } from "./sellers-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, sha, waitForApiLockWait, routes, type Reply } from "./support.js";

let pw: PaymentsWorld;
invariantsAfterEach(() => pw.w.h.oracle);
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const versionsUrl = (capabilityId: string): string => `/api/v1/operations/capabilities/${capabilityId}/versions`;
const restrictUrl = (capabilityId: string): string => `/api/v1/operations/capabilities/${capabilityId}/restrict`;
const ownerId = (): UserId => pw.kora.userId as UserId;

type PathState = "DESIGN" | "IMPLEMENTED_UNACCEPTED" | "QUALIFIED_INTERNAL" | "AVAILABLE_LIMITED" | "AVAILABLE";

/** A TOOL capability (no mode: no admission predicate rides on it) walked to `state` along the listed edges, as the control plane does. */
async function capability(label: string, state: PathState = "QUALIFIED_INTERNAL"): Promise<string> {
  const { w } = pw;
  const id = ids.next();
  await w.h.oracle.query(
    `INSERT INTO kauro.capabilities (capability_id, version, kind, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
     VALUES ($1, $2, 'TOOL', 'DESIGN', $3, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
    [id, `B18-${label}`, sha(`profile-${label}`)],
  );
  if (state !== "DESIGN") await w.h.publishCapability(id as never, state);
  return id;
}

const capabilityRow = async (capabilityId: string) =>
  (await pw.w.h.oracle.query<{ state: string; revision: number; profile_hash: string }>("SELECT state, revision, profile_hash FROM kauro.capabilities WHERE capability_id = $1", [capabilityId])).rows[0]!;
const versionRows = async (capabilityId: string) =>
  (await pw.w.h.oracle.query<{ version_no: number; status: string; profile_hash: string; qualification_evidence_hashes: string[]; recorded_by_user_id: string; created_at: Date }>("SELECT * FROM kauro.capability_versions WHERE capability_id = $1 ORDER BY version_no", [capabilityId])).rows;
const restrictionRows = async (capabilityId: string) =>
  (await pw.w.h.oracle.query<{ incident_ref: string; prior_state: string; revision_after: number; recorded_by_user_id: string; created_at: Date }>("SELECT * FROM kauro.capability_restrictions WHERE capability_id = $1", [capabilityId])).rows;

/**
 * S078 seeds: every TOOL capability version cites evidence that must resolve to a PASS vendor qualification of this capability, the body's
 * profile and an export-back hash. The rows are inserted through the oracle (no runtime role can) before each call; the unknown capability
 * and the CLEAN mode (outside the predicates) get none. The refusals of the five predicates are b17-vendor-qualification.test.ts's.
 */
async function qualify(capabilityId: string, body: Record<string, unknown>): Promise<void> {
  const refs = body["qualificationEvidenceRefs"];
  const profileHash = body["profileHash"];
  if (!Array.isArray(refs) || typeof profileHash !== "string") return;
  for (const ref of refs) {
    if (typeof ref !== "string") continue;
    await pw.w.h.oracle.query(
      `INSERT INTO kauro.vendor_qualifications (evidence_hash, capability_id, tool, profile_hash, envelope, export_back_evidence_hash, result)
       SELECT $1, capability_id, 'Data Loader', $3, '{"object":"Contact","operation":"UPSERT"}'::jsonb, $4, 'PASS' FROM kauro.capabilities WHERE capability_id = $2 AND kind = 'TOOL'
       ON CONFLICT (evidence_hash) DO NOTHING`,
      [ref, capabilityId, profileHash, sha(`export-back-${ref}`)],
    );
  }
}

async function change(capabilityId: string, body: Record<string, unknown>, options: { readonly token?: string; readonly key?: string } = {}): Promise<Reply> {
  await qualify(capabilityId, body);
  return call(pw.w, { url: versionsUrl(capabilityId), token: options.token ?? pw.kora.token, agency: null, key: options.key ?? freshKey("cmd058"), body });
}
async function restrict(capabilityId: string, body: Record<string, unknown>, options: { readonly token?: string; readonly key?: string } = {}): Promise<Reply> {
  return call(pw.w, { url: restrictUrl(capabilityId), token: options.token ?? pw.kora.token, agency: null, key: options.key ?? freshKey("cmd059"), body });
}
const changeBody = (label: string, expectedVersion = 1) => ({ expectedVersion, profileHash: sha(`new-profile-${label}`), qualificationEvidenceRefs: [sha(`evidence-a-${label}`), sha(`evidence-b-${label}`)] });

test("CMD058-OK: the owner records a PROSPECTIVE version of an independently accepted capability — 200 with the next version, the evidence cited, the capability state and profile untouched (no promotion)", async () => {
  const { w } = pw;
  const id = await capability("cmd058-ok", "QUALIFIED_INTERNAL");
  const body = changeBody("cmd058-ok");
  const key = freshKey("cmd058-ok");
  const done = completed<CapabilityVersionView>(await change(id, body, { key }), 200);
  assert.deepEqual([done.data.capabilityId, done.data.version, done.data.status, done.data.state, done.data.profileHash, done.data.qualificationEvidenceCount], [id, 2, "PROSPECTIVE", "QUALIFIED_INTERNAL", body.profileHash, 2]);
  assert.equal(done.version, 2);
  assert.match(done.data.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  // the rows: one append-only PROSPECTIVE version stamped by the database and the owner, the revision advanced, the state and profile as they were
  const rows = await versionRows(id);
  assert.deepEqual(rows.map((r) => [r.version_no, r.status, r.profile_hash, r.qualification_evidence_hashes, r.recorded_by_user_id]), [[2, "PROSPECTIVE", body.profileHash, body.qualificationEvidenceRefs, ownerId()]]);
  assert.deepEqual(await capabilityRow(id), { state: "QUALIFIED_INTERNAL", revision: 2, profile_hash: sha("profile-cmd058-ok") });
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 200, kind: "capability", id });
  await assert.rejects(w.h.oracle.query("UPDATE kauro.capability_versions SET status = 'PROSPECTIVE' WHERE capability_id = $1", [id]), "versions are append-only");

  // the next version is read from version 2; an offered capability is versioned too and stays offered
  const next = completed<CapabilityVersionView>(await change(id, changeBody("cmd058-ok-2", 2)), 200);
  assert.deepEqual([next.data.version, next.data.status], [3, "PROSPECTIVE"]);
  const offered = await capability("cmd058-ok-offered", "AVAILABLE");
  const third = completed<CapabilityVersionView>(await change(offered, changeBody("cmd058-ok-offered")), 200);
  assert.equal(third.data.state, "AVAILABLE");
  assert.equal((await capabilityRow(offered)).state, "AVAILABLE");
});

test("CMD058-DENY: an agency member and a stranger are refused (403) and a request session can never promote a capability; then one missing prerequisite at a time — IMPLEMENTED_UNACCEPTED or DESIGN has no independent acceptance, a stale version, an unchanged profile, an unknown capability — nothing is written", async () => {
  const { w } = pw;
  const id = await capability("cmd058-deny", "QUALIFIED_INTERNAL");
  const body = changeBody("cmd058-deny");
  const before = { row: await capabilityRow(id), versions: await versionRows(id) };
  const untouched = async (what: string) => {
    assert.deepEqual(await capabilityRow(id), before.row, `${what}: the capability is as it was`);
    assert.deepEqual(await versionRows(id), before.versions, `${what}: no version was written`);
  };

  // wrong role: an agency member's tenant session and a person with no grant
  const member = await w.person("cmd058-deny-member");
  await w.h.addMember(w.A, member.userId, "BILLING");
  const stranger = await w.person("cmd058-deny-stranger");
  const denials = (await w.securityEvents("CMD058")).length;
  assert.equal(outcome(w, await change(id, body, { token: member.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal(outcome(w, await change(id, body, { token: stranger.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w.securityEvents("CMD058")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);
  await untouched("wrong role");

  // a marketing edit cannot promote: the owner's own request session cannot move the state to anything but SUSPENDED, and a person with no grant moves nothing
  const promoted = await asPerson(w.h, ownerId(), (q) => q.query("UPDATE kauro.capabilities SET state = 'AVAILABLE_LIMITED' WHERE capability_id = $1", [id]).then(() => "moved", (e: { code?: string }) => e.code));
  assert.equal(promoted, "KA008", "a request session cannot promote a capability: the edge is the control plane's");
  assert.equal(await asPerson(w.h, stranger.userId, (q) => q.query("UPDATE kauro.capabilities SET revision = revision + 1 WHERE capability_id = $1", [id]).then((r) => r.rowCount, () => 0)), 0, "only the corporate owner session updates a capability");
  await untouched("promotion attempts");

  // no independent acceptance: a version never stands in for it
  for (const state of ["IMPLEMENTED_UNACCEPTED", "DESIGN"] as const) {
    const unaccepted = await capability(`cmd058-deny-${state}`, state);
    const reply = await change(unaccepted, changeBody(`cmd058-deny-${state}`));
    assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED CAPABILITY_NOT_ACCEPTED", state);
    assert.deepEqual(asProblem(w, reply).current, { version: 1, state });
    assert.deepEqual([(await capabilityRow(unaccepted)).state, (await versionRows(unaccepted)).length], [state, 0], `${state}: nothing written`);
  }
  // a stale version, an unchanged profile (the capability's own, and a version's own), an unknown capability
  assert.equal(outcome(w, await change(id, { ...body, expectedVersion: 7 })), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, await change(id, { ...body, expectedVersion: 7 })).current, { version: 1, state: "QUALIFIED_INTERNAL" });
  assert.equal(outcome(w, await change(id, { ...body, profileHash: sha("profile-cmd058-deny") })), "409 PRECONDITION_FAILED CAPABILITY_PROFILE_UNCHANGED");
  assert.equal(outcome(w, await change(ids.next(), body)), "404 NOT_FOUND -");
  // invalid shape: no evidence, an unknown member
  assert.equal((await change(id, { ...body, qualificationEvidenceRefs: [] })).status, 400);
  assert.equal((await change(id, { ...body, state: "AVAILABLE" })).status, 400, "a request cannot carry a state");
  await untouched("every refusal");

  // the same request, correct, is accepted: the refusals above were the only obstacle
  completed<CapabilityVersionView>(await change(id, body), 200);
  assert.equal((await versionRows(id)).length, 1);
});

test("CMD058-RACE: an identical retry replays the 200, the same key with another profile is 409 IDEMPOTENCY_CONFLICT, two versions on one expectedVersion yield one version and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves no version", async () => {
  const { w } = pw;
  const id = await capability("cmd058-race", "QUALIFIED_INTERNAL");
  const key = freshKey("cmd058-race");
  const body = changeBody("cmd058-race");
  const first = await change(id, body, { key });
  completed<CapabilityVersionView>(first, 200);
  const replay = await change(id, body, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await versionRows(id)).length, 1, "the replay recorded nothing a second time");
  assert.equal(outcome(w, await change(id, { ...body, profileHash: sha("another") }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await capabilityRow(id)).revision, 2);

  // two versions on one expectedVersion: the first holds the capability row until its commit, the second waits (pg_stat_activity), reads
  // revision 2 and is refused: one version
  const racing = await capability("cmd058-race-two", "AVAILABLE_LIMITED");
  const hold = w.holds.arm("journal.commit");
  const winner = change(racing, changeBody("cmd058-race-two-a"));
  await hold.reached;
  const loser = change(racing, changeBody("cmd058-race-two-b"));
  try {
    await waitForApiLockWait(w, "FROM kauro.capabilities");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  completed<CapabilityVersionView>(won, 200);
  assert.equal(outcome(w, lost), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, lost).current, { version: 2, state: "AVAILABLE_LIMITED" });
  assert.equal((await versionRows(racing)).length, 1, "one version");

  // a crash at the intent/commit boundary: the version was written and never committed; the capability is as it was
  const crashing = await capability("cmd058-race-crash", "QUALIFIED_INTERNAL");
  const crashKey = freshKey("cmd058-crash");
  const crashBody = changeBody("cmd058-race-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await change(crashing, crashBody, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual([(await capabilityRow(crashing)).revision, (await versionRows(crashing)).length], [1, 0]);
  assert.equal(await w.journal(crashKey), null);
  completed<CapabilityVersionView>(await change(crashing, crashBody, { key: crashKey }), 200);
  assert.deepEqual([(await capabilityRow(crashing)).revision, (await versionRows(crashing)).length], [2, 1]);
});

test("CMD059-OK: the owner restricts the offered CLEAN capability — 200 with it SUSPENDED and the restriction evidence kept, new admission refused, the project already created under it left exactly as it was", async () => {
  const { w } = pw;
  const created = completed<{ projectId: string }>(await call(w, { url: routes.createProject(w.clientA), token: w.operator.token, body: { mode: "CLEAN", purpose: "Paid before the restriction" } }), 201);
  const projectOf = async () => (await w.h.oracle.query("SELECT * FROM kauro.projects WHERE project_id = $1", [created.data.projectId])).rows[0];
  const projectBefore = await projectOf();
  const before = await capabilityRow(w.cleanCapabilityId);
  assert.equal(before.state, "AVAILABLE_LIMITED");

  const incident = ids.next();
  const key = freshKey("cmd059-ok");
  const done = completed<CapabilityRestrictionView>(await restrict(w.cleanCapabilityId, { expectedVersion: before.revision, incidentRef: incident }, { key }), 200);
  assert.deepEqual([done.data.capabilityId, done.data.version, done.data.state, done.data.priorState, done.data.incidentRef, done.data.newAdmissionBlocked], [w.cleanCapabilityId, before.revision + 1, "SUSPENDED", "AVAILABLE_LIMITED", incident, true]);
  assert.match(done.data.restrictedAt, /^\d{4}-\d{2}-\d{2}T/);

  // rows: SUSPENDED at the next revision, the evidence kept (append-only), the evidence hashes of the capability as they were
  const after = await capabilityRow(w.cleanCapabilityId);
  assert.deepEqual([after.state, after.revision, after.profile_hash], ["SUSPENDED", before.revision + 1, before.profile_hash]);
  const evidence = await restrictionRows(w.cleanCapabilityId);
  assert.deepEqual(evidence.map((r) => [r.incident_ref, r.prior_state, r.revision_after, r.recorded_by_user_id]), [[incident, "AVAILABLE_LIMITED", before.revision + 1, ownerId()]]);
  await assert.rejects(w.h.oracle.query("DELETE FROM kauro.capability_restrictions WHERE capability_id = $1", [w.cleanCapabilityId]), "the evidence is append-only");

  // admission of new work: refused from the next request on; the paid project's row is exactly what it was (scope, capability and version)
  assert.equal(outcome(w, await call(w, { url: routes.createProject(w.clientA), token: w.operator.token, body: { mode: "CLEAN", purpose: "After the restriction" } })), "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED");
  assert.deepEqual(await projectOf(), projectBefore, "a restriction never changes the scope of an existing project");
});

test("CMD059-DENY: an agency member and a stranger are refused (403); then one missing prerequisite at a time — a stale version, an already SUSPENDED or DESIGN capability, an unknown capability — nothing is written and no project row moves", async () => {
  const { w } = pw;
  const id = await capability("cmd059-deny", "AVAILABLE");
  const incident = ids.next();
  const before = { row: await capabilityRow(id), projects: (await w.h.oracle.query("SELECT project_id, version, state, capability_id, capability_version FROM kauro.projects ORDER BY project_id")).rows };
  const untouched = async (what: string) => {
    assert.deepEqual(await capabilityRow(id), before.row, `${what}: the capability is as it was`);
    assert.deepEqual(await restrictionRows(id), [], `${what}: no restriction was written`);
  };
  const member = await w.person("cmd059-deny-member");
  await w.h.addMember(w.A, member.userId, "OWNER");
  const stranger = await w.person("cmd059-deny-stranger");
  const denials = (await w.securityEvents("CMD059")).length;
  assert.equal(outcome(w, await restrict(id, { expectedVersion: 1, incidentRef: incident }, { token: member.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "an agency OWNER is not the corporate owner");
  assert.equal(outcome(w, await restrict(id, { expectedVersion: 1, incidentRef: incident }, { token: stranger.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w.securityEvents("CMD059")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);
  await untouched("wrong role");

  assert.equal(outcome(w, await restrict(id, { expectedVersion: 9, incidentRef: incident })), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, await restrict(id, { expectedVersion: 9, incidentRef: incident })).current, { version: 1, state: "AVAILABLE" });
  const design = await capability("cmd059-deny-design", "DESIGN");
  const reply = await restrict(design, { expectedVersion: 1, incidentRef: incident });
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED CAPABILITY_NOT_RESTRICTABLE");
  assert.equal((await capabilityRow(design)).state, "DESIGN");
  assert.equal(outcome(w, await restrict(ids.next(), { expectedVersion: 1, incidentRef: incident })), "404 NOT_FOUND -");
  assert.equal((await restrict(id, { expectedVersion: 1 })).status, 400, "an incident is required");
  assert.equal((await restrict(id, { expectedVersion: 1, incidentRef: incident, projects: "all" })).status, 400, "a request names no project scope");
  await untouched("every refusal");

  // the correct request is accepted, then the capability is SUSPENDED: restricting again is a typed refusal, never a second restriction
  completed<CapabilityRestrictionView>(await restrict(id, { expectedVersion: 1, incidentRef: incident }), 200);
  const again = await restrict(id, { expectedVersion: 2, incidentRef: ids.next() });
  assert.equal(outcome(w, again), "409 PRECONDITION_FAILED CAPABILITY_NOT_RESTRICTABLE");
  assert.deepEqual(asProblem(w, again).current, { version: 2, state: "SUSPENDED" });
  assert.equal((await restrictionRows(id)).length, 1);
  assert.deepEqual((await w.h.oracle.query("SELECT project_id, version, state, capability_id, capability_version FROM kauro.projects ORDER BY project_id")).rows, before.projects, "no project row moved");
  // a SUSPENDED capability can be versioned (the way sale eligibility is restored), and is still not promoted by it
  const restored = completed<CapabilityVersionView>(await change(id, changeBody("cmd059-deny-restore", 2)), 200);
  assert.deepEqual([restored.data.version, restored.data.state], [3, "SUSPENDED"]);
});

test("CMD059-RACE: an identical retry replays the 200, the same key with another incident is 409 IDEMPOTENCY_CONFLICT, two restrictions on one expectedVersion yield one restriction and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the capability offered", async () => {
  const { w } = pw;
  const id = await capability("cmd059-race", "AVAILABLE_LIMITED");
  const key = freshKey("cmd059-race");
  const body = { expectedVersion: 1, incidentRef: ids.next() };
  const first = await restrict(id, body, { key });
  completed<CapabilityRestrictionView>(first, 200);
  const replay = await restrict(id, body, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await restrictionRows(id)).length, 1, "the replay restricted nothing a second time");
  assert.equal(outcome(w, await restrict(id, { ...body, incidentRef: ids.next() }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await capabilityRow(id)).revision, 2);

  // two restrictions on one expectedVersion: the first holds the capability row until its commit; the second waits, then reads SUSPENDED
  const racing = await capability("cmd059-race-two", "AVAILABLE_LIMITED");
  const hold = w.holds.arm("journal.commit");
  const winner = restrict(racing, { expectedVersion: 1, incidentRef: ids.next() });
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

  // a crash at the intent/commit boundary: the suspension was written and never committed; the capability is still offered
  const crashing = await capability("cmd059-race-crash", "AVAILABLE_LIMITED");
  const crashKey = freshKey("cmd059-crash");
  const crashBody = { expectedVersion: 1, incidentRef: ids.next() };
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await restrict(crashing, crashBody, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual([(await capabilityRow(crashing)).state, (await capabilityRow(crashing)).revision, (await restrictionRows(crashing)).length], ["AVAILABLE_LIMITED", 1, 0]);
  assert.equal(await w.journal(crashKey), null);
  completed<CapabilityRestrictionView>(await restrict(crashing, crashBody, { key: crashKey }), 200);
  assert.equal((await capabilityRow(crashing)).state, "SUSPENDED");
});

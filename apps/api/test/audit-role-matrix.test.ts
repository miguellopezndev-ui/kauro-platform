// The audit commands, the decision-artifact intake and the audit read against every role of a real membership (B08 design §12, D8-API-1; B06
// re-check finding N17 extended to the routes mandate B08-COMMANDS-AUDIT served; 21 "Positive and negative symmetry"; 08 "Identity is not
// permission"): OWNER, ADMIN, OPERATOR, APPROVER, BILLING and VIEWER memberships, a SUSPENDED member, an INVITED member who never accepted, and a
// member of another agency. CMD020 StartAudit, CMD021 CancelAudit, CMD022 CreatePlan, CMD024 ValidatePlan and the intake of the decision artifacts
// take the registry role AGENCY_OPERATOR (OWNER, ADMIN, OPERATOR); GetAudit takes AGENCY_READER (every live membership). Each denial is asserted
// by status, code and reason, by its durable security fact in the right stream (the commands and the read; the intake answers its role refusal
// from its handler, as B07's does) and by the absence of any journal entry, event, audit, plan or artifact; each admitted role succeeds through the
// same route. Real routes, real composition root, real PostgreSQL 17; the control plane's steps are written through the product's adapters
// (audit-support.ts), so no provider is reached.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readData } from "./commerce-support.js";
import {
  auditRow,
  auditsOfAgency,
  auditWorld,
  cancelAudit,
  createPlan,
  decidedBody,
  driveTo,
  endLiveAudits,
  footprint,
  fundPool,
  getAudit,
  planRow,
  requiredPlan,
  startAudit,
  startedAudit,
  storeDecisionArtifact,
  storedCandidates,
  subjectOf,
  validatePlan,
  validationsOf,
  type AuditView,
  type AuditWorld,
} from "./audit-support.js";
import { freshKey, outcome, type Person, type Reply } from "./support.js";

type Role = "OWNER" | "ADMIN" | "OPERATOR" | "APPROVER" | "BILLING" | "VIEWER" | "SUSPENDED" | "INVITED" | "NON_MEMBER";
const ROLES: ReadonlyArray<Role> = ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER", "SUSPENDED", "INVITED", "NON_MEMBER"];
/** AGENCY_OPERATOR, the registry role of CMD020, CMD021, CMD022 and CMD024 (domain roles.ts; B06 D-AUTHZ-1). */
const OPERATING: ReadonlySet<Role> = new Set(["OWNER", "ADMIN", "OPERATOR"]);
/** AGENCY_READER: every live membership of the agency reads (domain roles.ts). */
const READING: ReadonlySet<Role> = new Set(["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER"]);

function denialOf(role: Role): string {
  if (role === "SUSPENDED") return "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED";
  if (role === "INVITED") return "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE";
  if (role === "NON_MEMBER") return "404 NOT_FOUND NOT_A_MEMBER";
  return "403 NOT_AUTHORIZED ROLE_INSUFFICIENT";
}

let aw: AuditWorld;
let people: Readonly<Record<Role, Person>>;
before(async () => {
  aw = await auditWorld();
  await fundPool(aw);
  const { w } = aw;
  people = { OWNER: w.owner, ADMIN: w.admin, OPERATOR: w.operator, APPROVER: w.approver, BILLING: w.billing, VIEWER: w.viewer, SUSPENDED: w.suspended, INVITED: w.invited, NON_MEMBER: w.stranger };
});
after(async () => {
  await aw.stop();
});

async function securityFactOf(reply: Reply): Promise<{ action: string; outcome: string; reason: string | null; agencyId: string | null; requestedAgencyId: string | null; actorId: string | null } | null> {
  const r = await aw.w.h.oracle.query<{ action: string; outcome: string; reason_code: string | null; agency_id: string | null; requested_agency_id: string | null; actor_id: string | null }>(
    "SELECT action, outcome, reason_code, agency_id, requested_agency_id, actor_id FROM kauro.security_events WHERE correlation_id = $1 AND outcome = 'DENY'",
    [String(reply.headers["x-correlation-id"])],
  );
  const row = r.rows[0];
  assert.ok(r.rows.length <= 1, "one denial fact per request");
  return row ? { action: row.action, outcome: row.outcome, reason: row.reason_code, agencyId: row.agency_id, requestedAgencyId: row.requested_agency_id, actorId: row.actor_id } : null;
}

/** The durable denial: a member's in the agency's stream, a non-member's in the caller's own with the agency the request selected named. */
async function assertDenied(action: string, role: Role, reply: Reply, what: string): Promise<void> {
  assert.equal(outcome(aw.w, reply), denialOf(role), what);
  const reason = denialOf(role).split(" ")[2] ?? null;
  const person = people[role];
  assert.deepEqual(
    await securityFactOf(reply),
    role === "NON_MEMBER"
      ? { action, outcome: "DENY", reason, agencyId: null, requestedAgencyId: aw.w.A.agencyId, actorId: person.userId }
      : { action, outcome: "DENY", reason, agencyId: aw.w.A.agencyId, requestedAgencyId: null, actorId: person.userId },
    `${what}: the durable denial`,
  );
}

test("every audit command, the decision-artifact intake and the audit read against every role — OWNER, ADMIN, OPERATOR, APPROVER, BILLING, VIEWER, a SUSPENDED and an INVITED member, a member of another agency: CMD020, CMD021, CMD022, CMD024 and the intake admit the AGENCY_OPERATOR roles, GetAudit every live membership, and every denial is durable and writes nothing", async () => {
  const { w } = aw;
  const tally = { allowed: 0, denied: 0 };

  // CMD020 StartAudit: a fresh subject per request, its audit (if any) ended afterwards so the agency's one live audit is never the reason
  for (const role of ROLES) {
    await endLiveAudits(w);
    const subject = await subjectOf(w);
    const key = freshKey(`matrix-cmd020-${role}`);
    const audits = (await auditsOfAgency(w)).length;
    const written = await footprint(w);
    const reply = await startAudit(w, subject.revisionId, { targetContractId: subject.contractId }, { token: people[role].token, key });
    const what = `CMD020 as ${role}`;
    if (OPERATING.has(role)) {
      assert.equal(reply.status, 202, `${what}: ${reply.status} ${reply.text}`);
      assert.equal((await w.journal(key))?.state, "COMMITTED", what);
      assert.equal((await auditsOfAgency(w)).length, audits + 1, `${what}: one audit`);
      tally.allowed += 1;
    } else {
      await assertDenied("CMD020", role, reply, what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal((await auditsOfAgency(w)).length, audits, `${what}: no audit`);
      assert.deepEqual(await footprint(w), written, `${what}: nothing written`);
      tally.denied += 1;
    }
  }
  await endLiveAudits(w);

  // CMD021 CancelAudit: a queued audit per request
  for (const role of ROLES) {
    await endLiveAudits(w);
    const started = await startedAudit(aw);
    const key = freshKey(`matrix-cmd021-${role}`);
    const eventsBefore = await w.count("domain_events");
    const reply = await cancelAudit(w, started.auditId, { expectedVersion: 1 }, { token: people[role].token, key });
    const what = `CMD021 as ${role}`;
    if (OPERATING.has(role)) {
      assert.equal(reply.status, 200, `${what}: ${reply.status} ${reply.text}`);
      assert.equal((await w.journal(key))?.state, "COMMITTED", what);
      assert.equal((await auditRow(w, started.auditId)).state, "CANCELLED", `${what}: the cancellation is recorded`);
      tally.allowed += 1;
    } else {
      await assertDenied("CMD021", role, reply, what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      const row = await auditRow(w, started.auditId);
      assert.deepEqual([row.state, row.version, row.cancel_version], ["QUEUED", "1", "0"], `${what}: the audit is untouched`);
      tally.denied += 1;
    }
  }
  await endLiveAudits(w);

  // CMD022 CreatePlan: an audit that needs decisions per request, with its candidate decisions stored by an operator
  for (const role of ROLES) {
    await endLiveAudits(w);
    const started = await startedAudit(aw);
    await driveTo(w, started, "NEEDS_DECISION");
    const stored = await storedCandidates(w, started.auditId, decidedBody(started.subject, `matrix-cmd022-${role}`));
    const key = freshKey(`matrix-cmd022-${role}`);
    const plans = await w.count("plans");
    const eventsBefore = await w.count("domain_events");
    const reply = await createPlan(w, started.auditId, { candidateDecisionArtifactRef: stored.artifactRef }, { token: people[role].token, key });
    const what = `CMD022 as ${role}`;
    if (OPERATING.has(role)) {
      assert.equal(reply.status, 201, `${what}: ${reply.status} ${reply.text}`);
      assert.equal((await w.journal(key))?.state, "COMMITTED", what);
      assert.equal(await w.count("plans"), plans + 1, `${what}: one plan`);
      tally.allowed += 1;
    } else {
      await assertDenied("CMD022", role, reply, what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal(await w.count("plans"), plans, `${what}: no plan`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      tally.denied += 1;
    }
  }

  // CMD024 ValidatePlan: a plan at VALIDATION_REQUIRED per request
  for (const role of ROLES) {
    const plan = await requiredPlan(w, await subjectOf(w), `matrix-cmd024-${role}`);
    const key = freshKey(`matrix-cmd024-${role}`);
    const eventsBefore = await w.count("domain_events");
    const reply = await validatePlan(w, plan.planId, { expectedVersion: plan.version, planHash: plan.bodyHash }, { token: people[role].token, key });
    const what = `CMD024 as ${role}`;
    if (OPERATING.has(role)) {
      assert.equal(reply.status, 202, `${what}: ${reply.status} ${reply.text}`);
      assert.equal((await w.journal(key))?.state, "COMMITTED", what);
      assert.equal((await planRow(w, plan.planId)).state, "VALIDATING", `${what}: the plan is under validation`);
      assert.equal((await validationsOf(w, plan.planId)).length, 1, `${what}: one intent`);
      tally.allowed += 1;
    } else {
      await assertDenied("CMD024", role, reply, what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      assert.deepEqual([(await planRow(w, plan.planId)).state, (await validationsOf(w, plan.planId)).length], ["VALIDATION_REQUIRED", 0], `${what}: the plan is untouched`);
      tally.denied += 1;
    }
  }

  // the intake of the decision artifacts: not a command (no journal entry), the same operating role; its refusal by role is the handler's
  await endLiveAudits(w);
  const target = await startedAudit(aw);
  await driveTo(w, target, "NEEDS_DECISION");
  for (const role of ROLES) {
    const artifacts = await w.count("decision_artifacts");
    const eventsBefore = await w.count("domain_events");
    const reply = await storeDecisionArtifact(w, target.auditId, { kind: "CANDIDATE_DECISIONS", document: { body: decidedBody(target.subject, `matrix-intake-${role}`) } }, { token: people[role].token });
    const what = `the intake as ${role}`;
    if (OPERATING.has(role)) {
      assert.equal(reply.status, 201, `${what}: ${reply.status} ${reply.text}`);
      assert.equal(await w.count("decision_artifacts"), artifacts + 1, `${what}: one artifact`);
      tally.allowed += 1;
    } else {
      assert.equal(outcome(w, reply), denialOf(role), what);
      assert.equal(await w.count("decision_artifacts"), artifacts, `${what}: no artifact`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      tally.denied += 1;
    }
  }

  // GetAudit: one audit, read by every role; a read writes no journal entry and no event
  for (const role of ROLES) {
    const eventsBefore = await w.count("domain_events");
    const reply = await getAudit(w, target.auditId, people[role].token);
    const what = `GetAudit as ${role}`;
    if (READING.has(role)) {
      assert.equal(readData<AuditView>(reply).auditId, target.auditId, what);
      tally.allowed += 1;
    } else {
      await assertDenied("GET_AUDIT", role, reply, what);
      tally.denied += 1;
    }
    assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
  }

  assert.deepEqual(tally, { allowed: 21, denied: 33 });
});

// The execution commands and the job read against every role of a real membership (B08 design §12, D8-API-1; B06 re-check finding N17
// extended to the routes mandate B08-COMMANDS-EXECUTION served; 21 "Positive and negative symmetry"; 08 "Identity is not permission"):
// OWNER, ADMIN, OPERATOR, APPROVER, BILLING and VIEWER memberships, a SUSPENDED member, an INVITED member who never accepted, and a member
// of another agency. CMD036 ExecuteProject and CMD037 CancelJob take the registry role AGENCY_OPERATOR (OWNER, ADMIN, OPERATOR); GetJob
// takes AGENCY_READER (every live membership). Each denial is asserted by status, code and reason, by its durable security fact in the
// right stream and by the absence of any journal entry, event or job; each admitted role succeeds through the same route. Real routes,
// real composition root, real PostgreSQL 17; the purchases are B09's `paidPurchase` fixture and the control plane's steps are written
// through the product's adapters (execution-support.ts), so no provider is reached.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { paymentsWorld, readData, type PaymentsWorld } from "./commerce-support.js";
import { cancel, endLiveJobs, execute, getJob, jobRow, queuedThroughRoute, runningJob, type JobView } from "./execution-support.js";
import { freshKey, outcome, type Person, type Reply } from "./support.js";

type Role = "OWNER" | "ADMIN" | "OPERATOR" | "APPROVER" | "BILLING" | "VIEWER" | "SUSPENDED" | "INVITED" | "NON_MEMBER";
const ROLES: ReadonlyArray<Role> = ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER", "SUSPENDED", "INVITED", "NON_MEMBER"];
/** AGENCY_OPERATOR, the registry role of CMD036 and CMD037 (domain roles.ts; B06 D-AUTHZ-1). */
const OPERATING: ReadonlySet<Role> = new Set(["OWNER", "ADMIN", "OPERATOR"]);
/** AGENCY_READER: every live membership of the agency reads (domain roles.ts). */
const READING: ReadonlySet<Role> = new Set(["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER"]);

function denialOf(role: Role): string {
  if (role === "SUSPENDED") return "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED";
  if (role === "INVITED") return "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE";
  if (role === "NON_MEMBER") return "404 NOT_FOUND NOT_A_MEMBER";
  return "403 NOT_AUTHORIZED ROLE_INSUFFICIENT";
}

let pw: PaymentsWorld;
let people: Readonly<Record<Role, Person>>;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"] });
  const { w } = pw;
  people = { OWNER: w.owner, ADMIN: w.admin, OPERATOR: w.operator, APPROVER: w.approver, BILLING: w.billing, VIEWER: w.viewer, SUSPENDED: w.suspended, INVITED: w.invited, NON_MEMBER: w.stranger };
});
after(async () => {
  await pw.stop();
});

async function securityFactOf(reply: Reply): Promise<{ action: string; outcome: string; reason: string | null; agencyId: string | null; requestedAgencyId: string | null; actorId: string | null } | null> {
  const r = await pw.w.h.oracle.query<{ action: string; outcome: string; reason_code: string | null; agency_id: string | null; requested_agency_id: string | null; actor_id: string | null }>(
    "SELECT action, outcome, reason_code, agency_id, requested_agency_id, actor_id FROM kauro.security_events WHERE correlation_id = $1 AND outcome = 'DENY'",
    [String(reply.headers["x-correlation-id"])],
  );
  const row = r.rows[0];
  assert.ok(r.rows.length <= 1, "one denial fact per request");
  return row ? { action: row.action, outcome: row.outcome, reason: row.reason_code, agencyId: row.agency_id, requestedAgencyId: row.requested_agency_id, actorId: row.actor_id } : null;
}

/** The durable denial: a member's in the agency's stream, a non-member's in the caller's own with the agency the request selected named. */
async function assertDenied(action: string, role: Role, reply: Reply, what: string): Promise<void> {
  assert.equal(outcome(pw.w, reply), denialOf(role), what);
  const reason = denialOf(role).split(" ")[2] ?? null;
  const person = people[role];
  assert.deepEqual(
    await securityFactOf(reply),
    role === "NON_MEMBER"
      ? { action, outcome: "DENY", reason, agencyId: null, requestedAgencyId: pw.w.A.agencyId, actorId: person.userId }
      : { action, outcome: "DENY", reason, agencyId: pw.w.A.agencyId, requestedAgencyId: null, actorId: person.userId },
    `${what}: the durable denial`,
  );
}

test("every execution command and the job read against every role — OWNER, ADMIN, OPERATOR, APPROVER, BILLING, VIEWER, a SUSPENDED and an INVITED member, a member of another agency: CMD036 and CMD037 admit the AGENCY_OPERATOR roles and GetJob every live member, and each refusal has its reason, its durable fact and no journal entry, event or job", async () => {
  const { w } = pw;
  const tally = { allowed: 0, denied: 0 };

  // CMD036 ExecuteProject: a fresh paid purchase per request, its job (if any) ended afterwards so the agency's bound is never the reason
  for (const role of ROLES) {
    const sale = await pw.paidProject(`matrix-cmd036-${role.toLowerCase()}`);
    const key = freshKey(`matrix-cmd036-${role}`);
    const eventsBefore = await w.count("domain_events");
    const jobsBefore = await w.count("processing_jobs");
    const reply = await execute(pw, sale, { token: people[role].token, key });
    const what = `CMD036 as ${role}`;
    if (OPERATING.has(role)) {
      assert.equal(reply.status, 202, `${what}: ${reply.status} ${reply.text}`);
      assert.equal((await w.journal(key))?.state, "COMMITTED", what);
      assert.equal(await w.count("processing_jobs"), jobsBefore + 1, `${what}: one job`);
      tally.allowed += 1;
    } else {
      await assertDenied("CMD036", role, reply, what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      assert.equal(await w.count("processing_jobs"), jobsBefore, `${what}: no job`);
      tally.denied += 1;
    }
    await endLiveJobs(pw);
  }

  // CMD037 CancelJob: a running job per request; the platform's slot it holds is freed by the control plane afterwards
  for (const role of ROLES) {
    const { jobId } = await runningJob(pw, `matrix-cmd037-${role.toLowerCase()}`);
    const before = await jobRow(pw, jobId);
    const key = freshKey(`matrix-cmd037-${role}`);
    const eventsBefore = await w.count("domain_events");
    const reply = await cancel(pw, jobId, { expectedVersion: Number(before.version), reasonCode: "The client asked to stop" }, { token: people[role].token, key });
    const what = `CMD037 as ${role}`;
    if (OPERATING.has(role)) {
      assert.equal(reply.status, 200, `${what}: ${reply.status} ${reply.text}`);
      assert.equal((await w.journal(key))?.state, "COMMITTED", what);
      assert.equal((await jobRow(pw, jobId)).state, "CANCEL_REQUESTED", `${what}: the cancellation is recorded`);
      tally.allowed += 1;
    } else {
      await assertDenied("CMD037", role, reply, what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      const after = await jobRow(pw, jobId);
      assert.equal(after.state, "RUNNING", `${what}: the job still runs`);
      assert.equal(after.cancel_version, before.cancel_version, `${what}: no cancellation`);
      tally.denied += 1;
    }
    await endLiveJobs(pw);
  }

  // GetJob: one job, read by every role; a read writes no journal entry and no event
  const { jobId } = await queuedThroughRoute(pw, "matrix-get-job");
  for (const role of ROLES) {
    const eventsBefore = await w.count("domain_events");
    const reply = await getJob(pw, jobId, people[role].token);
    const what = `GetJob as ${role}`;
    if (READING.has(role)) {
      assert.equal(readData<JobView>(reply).jobId, jobId, what);
      tally.allowed += 1;
    } else {
      await assertDenied("GET_JOB", role, reply, what);
      tally.denied += 1;
    }
    assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
  }

  assert.deepEqual(tally, { allowed: 12, denied: 15 });
});

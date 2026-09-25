// Every served command against every role of a real membership (re-check finding N17; prompts/B06 "deny tests for every role";
// 21 "Positive and negative symmetry"; 08 "Identity is not permission"; design D-AUTHZ-1): OWNER, ADMIN, OPERATOR, APPROVER,
// BILLING and VIEWER memberships, a SUSPENDED member, an INVITED member who never accepted, and a member of another agency.
// Each denial is asserted by status, code and reason, by the durable security fact it leaves (the agency's stream for a live
// membership of the agency, the caller's own stream naming the requested agency otherwise), and by the absence of any journal
// entry or event; each role the command admits shows its positive neighbour through the same route. Real routes, real
// composition root, real PostgreSQL 17.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ClientId, ProjectId } from "@kauro/domain";
import { approvalBodyOf, approveThroughRoute, call, freshKey, outcome, routes, world, type Call, type Person, type Reply, type World } from "./support.js";

type Role = "OWNER" | "ADMIN" | "OPERATOR" | "APPROVER" | "BILLING" | "VIEWER" | "SUSPENDED" | "INVITED" | "NON_MEMBER";
const ROLES: ReadonlyArray<Role> = ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER", "SUSPENDED", "INVITED", "NON_MEMBER"];
type TenantCommand = "CMD009" | "CMD010" | "CMD011" | "CMD023" | "CMD025" | "CMD026";

/** The membership roles each command's registry role admits (domain roles.ts; D-AUTHZ-1). */
const ADMITTED: Readonly<Record<TenantCommand, ReadonlySet<Role>>> = {
  CMD009: new Set(["OWNER", "ADMIN", "OPERATOR"]),
  CMD010: new Set(["OWNER", "ADMIN"]),
  CMD011: new Set(["OWNER", "ADMIN", "OPERATOR"]),
  CMD023: new Set(["OWNER", "ADMIN", "OPERATOR"]),
  CMD025: new Set(["OWNER", "APPROVER"]),
  CMD026: new Set(["OWNER", "APPROVER"]),
};

/** The denial each role that a command does not admit receives, before anything tenant-scoped is written (design §6.1). */
function denialOf(role: Role): string {
  if (role === "SUSPENDED") return "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED";
  if (role === "INVITED") return "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE";
  if (role === "NON_MEMBER") return "404 NOT_FOUND NOT_A_MEMBER";
  return "403 NOT_AUTHORIZED ROLE_INSUFFICIENT";
}

let w: World;
let projectId: ProjectId;
let people: Readonly<Record<Role, Person>>;
before(async () => {
  w = await world();
  projectId = (await w.project(w.A, w.clientA)).projectId;
  people = { OWNER: w.owner, ADMIN: w.admin, OPERATOR: w.operator, APPROVER: w.approver, BILLING: w.billing, VIEWER: w.viewer, SUSPENDED: w.suspended, INVITED: w.invited, NON_MEMBER: w.stranger };
});
after(async () => {
  await w.stop();
});

/** A request of `command` by `person`, on a fresh target where the command edits one. */
async function requestOf(command: TenantCommand, person: Person, key: string): Promise<Call> {
  switch (command) {
    case "CMD009":
      return { url: routes.createClient(w.A.agencyId), token: person.token, agency: null, key, body: { displayName: `Matrix client ${key}`, processingAuthorityRef: w.authorityA } };
    case "CMD010": {
      const clientId: ClientId = await w.h.endClient(w.A, w.authorityA, `Matrix archive ${key}`);
      return { url: routes.archiveClient(clientId), token: person.token, key, body: { expectedVersion: 1 } };
    }
    case "CMD011":
      return { url: routes.createProject(w.clientA), token: person.token, key, body: { mode: "CLEAN", purpose: `Matrix project ${key}` } };
    case "CMD023": {
      const plan = await w.approvable(w.A, projectId, `matrix-revise-${key}`);
      return { url: routes.revisePlan(plan.planId), token: person.token, key, body: { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "MATRIX" }) } };
    }
    case "CMD025": {
      const plan = await w.approvable(w.A, projectId, `matrix-approve-${key}`);
      return { url: routes.approvePlan(plan.planId), token: person.token, key, body: approvalBodyOf(plan, await w.stepUp(person)) };
    }
    case "CMD026": {
      const plan = await w.approvable(w.A, projectId, `matrix-withdraw-${key}`);
      await approveThroughRoute(w, plan);
      return { url: routes.withdrawApproval(plan.planId), token: person.token, key, body: { expectedVersion: 5, reasonCode: "MATRIX_REVIEW" } };
    }
  }
}

async function securityFactOf(reply: Reply): Promise<{ action: string; outcome: string; reason: string | null; agencyId: string | null; requestedAgencyId: string | null; actorId: string | null } | null> {
  const r = await w.h.oracle.query<{ action: string; outcome: string; reason_code: string | null; agency_id: string | null; requested_agency_id: string | null; actor_id: string | null }>(
    "SELECT action, outcome, reason_code, agency_id, requested_agency_id, actor_id FROM kauro.security_events WHERE correlation_id = $1",
    [String(reply.headers["x-correlation-id"])],
  );
  const row = r.rows[0];
  assert.ok(r.rows.length <= 1, "one fact per request");
  return row ? { action: row.action, outcome: row.outcome, reason: row.reason_code, agencyId: row.agency_id, requestedAgencyId: row.requested_agency_id, actorId: row.actor_id } : null;
}

test("N17: every served command against every role — OWNER, ADMIN, OPERATOR, APPROVER, BILLING, VIEWER, a SUSPENDED and an INVITED member, a member of another agency: each role the registry role does not admit is refused with its reason and a durable DENY fact in the right stream and no effect, and each admitted role succeeds through the same route", async () => {
  const tally = { allowed: 0, denied: 0 };
  for (const command of Object.keys(ADMITTED) as TenantCommand[]) {
    for (const role of ROLES) {
      const person = people[role];
      const key = freshKey(`matrix-${command}-${role}`);
      const request = await requestOf(command, person, key);
      const eventsBefore = await w.count("domain_events");
      const reply = await call(w, request);
      const what = `${command} as ${role}`;
      if (ADMITTED[command].has(role)) {
        assert.ok(reply.status === 200 || reply.status === 201, `${what}: ${reply.status} ${reply.text}`);
        assert.equal((await w.journal(key))?.state, "COMMITTED", what);
        tally.allowed += 1;
        continue;
      }
      assert.equal(outcome(w, reply), denialOf(role), what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      const fact = await securityFactOf(reply);
      // a live membership of A (ACTIVE, SUSPENDED or INVITED) proves the agency's stream; a member of another agency is a
      // fact of its own identity stream that names the agency it requested (never a write into A's stream)
      const reason = denialOf(role).split(" ")[2] ?? null;
      assert.deepEqual(
        fact,
        role === "NON_MEMBER"
          ? { action: command, outcome: "DENY", reason, agencyId: null, requestedAgencyId: w.A.agencyId, actorId: person.userId }
          : { action: command, outcome: "DENY", reason, agencyId: w.A.agencyId, requestedAgencyId: null, actorId: person.userId },
        `${what}: the durable denial`,
      );
      tally.denied += 1;
    }
  }
  assert.deepEqual(tally, { allowed: 15, denied: 39 });
});

test("N17: CreateAgency is identity-scoped — every verified identity creates its draft agency whatever its memberships elsewhere (an ADMIN, a BILLING, a SUSPENDED and an INVITED member of A, a member of another agency), and a disabled identity is refused with its durable fact", async () => {
  for (const role of ["ADMIN", "BILLING", "SUSPENDED", "INVITED"] as const) {
    const reply = await call(w, { url: routes.createAgency(), token: people[role].token, agency: null, body: { displayName: `Matrix agency of ${role}` } });
    assert.equal(reply.status, 201, `${role}: ${reply.text}`);
  }
  const outsider = await w.person("matrix-outsider");
  assert.equal((await call(w, { url: routes.createAgency(), token: outsider.token, agency: null, body: { displayName: "Matrix agency of an outsider" } })).status, 201);
  const disabled = await w.person("matrix-disabled", { state: "DISABLED" });
  const refused = await call(w, { url: routes.createAgency(), token: disabled.token, agency: null, body: { displayName: "Never created" } });
  assert.equal(outcome(w, refused), "403 NOT_AUTHORIZED IDENTITY_DISABLED");
  assert.deepEqual(await securityFactOf(refused), { action: "CMD001", outcome: "DENY", reason: "IDENTITY_DISABLED", agencyId: null, requestedAgencyId: null, actorId: disabled.userId });
});

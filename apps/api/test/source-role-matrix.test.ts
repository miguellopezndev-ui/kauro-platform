// The six source-lifecycle commands against every role of a real membership (B07 design §8; B06 re-check finding N17 extended to
// the commands mandate B07-COMMANDS served; 21 "Positive and negative symmetry"; 08 "Identity is not permission"): OWNER, ADMIN,
// OPERATOR, APPROVER, BILLING and VIEWER memberships, a SUSPENDED member, an INVITED member who never accepted, and a member of
// another agency. CMD012..CMD017 all take the registry role AGENCY_OPERATOR (OWNER, ADMIN, OPERATOR). Each denial is asserted by
// status, code and reason, by its durable security fact in the right stream and by the absence of any journal entry or event; each
// admitted role succeeds through the same route. Real routes, real composition root, real PostgreSQL 17; the providers are the
// labelled storage and vault fakes of @kauro/application/testing (SIMULATED).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { B07CommandId } from "@kauro/application";
import { call, freshKey, outcome, world, type Call, type Person, type Reply, type World } from "./support.js";
import { activate, csvContent, inventoryHashOfRoute, manifestOf, readyRevision, reserveBody, reserved, sessionUrlOf, setSessionLimit, sourceRoutes, storedManifest, uploadAndAdmit, uploadThrough } from "./source-support.js";

type Role = "OWNER" | "ADMIN" | "OPERATOR" | "APPROVER" | "BILLING" | "VIEWER" | "SUSPENDED" | "INVITED" | "NON_MEMBER";
const ROLES: ReadonlyArray<Role> = ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER", "SUSPENDED", "INVITED", "NON_MEMBER"];
/** AGENCY_OPERATOR, the registry role of every B07 command (domain roles.ts; B06 D-AUTHZ-1). */
const ADMITTED: ReadonlySet<Role> = new Set(["OWNER", "ADMIN", "OPERATOR"]);
const COMMANDS: ReadonlyArray<B07CommandId> = ["CMD012", "CMD013", "CMD014", "CMD015", "CMD016", "CMD017"];

function denialOf(role: Role): string {
  if (role === "SUSPENDED") return "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED";
  if (role === "INVITED") return "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE";
  if (role === "NON_MEMBER") return "404 NOT_FOUND NOT_A_MEMBER";
  return "403 NOT_AUTHORIZED ROLE_INSUFFICIENT";
}

let w: World;
let people: Readonly<Record<Role, Person>>;
before(async () => {
  w = await world();
  await activate(w);
  await setSessionLimit(w, w.A, 32);
  people = { OWNER: w.owner, ADMIN: w.admin, OPERATOR: w.operator, APPROVER: w.approver, BILLING: w.billing, VIEWER: w.viewer, SUSPENDED: w.suspended, INVITED: w.invited, NON_MEMBER: w.stranger };
});
after(async () => {
  await w.stop();
});

/**
 * A request of `command` by `person` on a fresh target. An upload a command acts on is its requester's own (D-SRC-2): the admitted
 * roles reserve their own; the others name an upload of the operator, refused by the access decision before ownership is read.
 */
async function requestOf(command: B07CommandId, role: Role, person: Person, key: string): Promise<Call> {
  switch (command) {
    case "CMD012": {
      const { projectId, revisionId } = await w.project(w.A, w.clientA);
      return { url: sourceRoutes.createRevision(projectId), token: person.token, key, body: { expectedVersion: 1, supersedesRevisionId: revisionId } };
    }
    case "CMD013": {
      const { revisionId } = await w.project(w.A, w.clientA);
      return { url: sourceRoutes.reserveUpload(revisionId), token: person.token, key, body: reserveBody(1) };
    }
    case "CMD014": {
      const { revisionId } = await w.project(w.A, w.clientA);
      const content = csvContent(2, `matrix-${key}`);
      const r = await reserved(w, revisionId, 1, { person: ADMITTED.has(role) ? person : w.operator, bytes: content.byteLength });
      const finalized = uploadThrough(w, sessionUrlOf(r), content);
      return { url: sourceRoutes.completeUpload(r.data.upload.uploadId), token: person.token, key, body: { providerCompletionRef: finalized.completionRef } };
    }
    case "CMD015": {
      const { revisionId } = await w.project(w.A, w.clientA);
      const r = await reserved(w, revisionId, 1, { person: ADMITTED.has(role) ? person : w.operator });
      return { url: sourceRoutes.cancelUpload(r.data.upload.uploadId), token: person.token, key, body: { expectedVersion: 2 } };
    }
    case "CMD016": {
      const { revisionId } = await w.project(w.A, w.clientA);
      const file = await uploadAndAdmit(w, revisionId, 1);
      const manifest = await storedManifest(w, revisionId, manifestOf(revisionId, await inventoryHashOfRoute(w, revisionId), [{ file }]));
      return { url: sourceRoutes.selectInputTables(revisionId), token: person.token, key, body: { expectedVersion: 2, selectionManifestRef: manifest.selectionManifestId } };
    }
    case "CMD017": {
      const ready = await readyRevision(w);
      return { url: sourceRoutes.sealRevision(ready.revisionId), token: person.token, key, body: { expectedVersion: ready.version, selectionHash: ready.selectionHash } };
    }
  }
}

async function securityFactOf(reply: Reply): Promise<{ action: string; outcome: string; reason: string | null; agencyId: string | null; requestedAgencyId: string | null; actorId: string | null } | null> {
  const r = await w.h.oracle.query<{ action: string; outcome: string; reason_code: string | null; agency_id: string | null; requested_agency_id: string | null; actor_id: string | null }>(
    "SELECT action, outcome, reason_code, agency_id, requested_agency_id, actor_id FROM kauro.security_events WHERE correlation_id = $1 AND outcome = 'DENY'",
    [String(reply.headers["x-correlation-id"])],
  );
  const row = r.rows[0];
  assert.ok(r.rows.length <= 1, "one denial fact per request");
  return row ? { action: row.action, outcome: row.outcome, reason: row.reason_code, agencyId: row.agency_id, requestedAgencyId: row.requested_agency_id, actorId: row.actor_id } : null;
}

test("every source-lifecycle command against every role — OWNER, ADMIN, OPERATOR, APPROVER, BILLING, VIEWER, a SUSPENDED and an INVITED member, a member of another agency: each role AGENCY_OPERATOR does not admit is refused with its reason, a durable DENY fact in the right stream and no effect, and each admitted role succeeds through the same route", async () => {
  const tally = { allowed: 0, denied: 0 };
  for (const command of COMMANDS) {
    for (const role of ROLES) {
      const person = people[role];
      const key = freshKey(`source-matrix-${command}-${role}`);
      const request = await requestOf(command, role, person, key);
      const eventsBefore = await w.count("domain_events");
      const reply = await call(w, request);
      const what = `${command} as ${role}`;
      if (ADMITTED.has(role)) {
        assert.ok(reply.status === 200 || reply.status === 201 || reply.status === 202, `${what}: ${reply.status} ${reply.text}`);
        assert.equal((await w.journal(key))?.state, "COMMITTED", what);
        tally.allowed += 1;
        continue;
      }
      assert.equal(outcome(w, reply), denialOf(role), what);
      assert.equal(await w.journal(key), null, `${what}: no journal entry`);
      assert.equal(await w.count("domain_events"), eventsBefore, `${what}: no event`);
      const reason = denialOf(role).split(" ")[2] ?? null;
      assert.deepEqual(
        await securityFactOf(reply),
        role === "NON_MEMBER"
          ? { action: command, outcome: "DENY", reason, agencyId: null, requestedAgencyId: w.A.agencyId, actorId: person.userId }
          : { action: command, outcome: "DENY", reason, agencyId: w.A.agencyId, requestedAgencyId: null, actorId: person.userId },
        `${what}: the durable denial`,
      );
      tally.denied += 1;
    }
  }
  assert.deepEqual(tally, { allowed: 18, denied: 36 });
});

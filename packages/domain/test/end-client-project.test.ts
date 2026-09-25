// EndClient and Project identity (CMD009, CMD010, CMD011; 07 "Aggregate ownership"; 10 "Client and project routes";
// decisions D-AGG-1, D-AGG-2, D-CMD-2, D-CMD-3, D-CMD-4). Oracle: the catalogue sentences of the three commands.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ClientId,
  PLATFORM_STATE_MACHINES,
  type ProjectId,
  type RevisionId,
  archiveEndClient,
  assertClientActive,
  createEndClient,
  createProject,
  eventsOf,
  isServiceMode,
  statesOf,
  transition,
} from "../src/index.js";
import { NOW, activeAgency, agency, at, authority, capability, client, id, membership, refused, users } from "./fixtures.js";

function world() {
  const ag = activeAgency();
  const owner = membership(ag.agencyId, "OWNER", users.owner);
  const admin = membership(ag.agencyId, "ADMIN", users.admin);
  const operator = membership(ag.agencyId, "OPERATOR", users.operator);
  const approver = membership(ag.agencyId, "APPROVER", users.approver);
  const viewer = membership(ag.agencyId, "VIEWER", users.viewer);
  const billing = membership(ag.agencyId, "BILLING", users.billing);
  const pa = authority(ag.agencyId, owner.membershipId);
  return { ag, owner, admin, operator, approver, viewer, billing, pa };
}

test("CMD009 createEndClient: one scoped ACTIVE workspace at version 1 whose identity is separate from its label; labels are never merged", () => {
  const { ag, operator, pa } = world();
  const clientId = id() as ClientId;
  const out = createEndClient({ clientId, displayName: "Client One", processingAuthorityRef: pa.processingAuthorityId, now: NOW }, { agency: ag, actor: operator, processingAuthority: pa });
  assert.equal(out.client.state, "ACTIVE");
  assert.equal(out.client.version, 1);
  assert.equal(out.client.agencyId, ag.agencyId);
  assert.equal(out.client.processingAuthorityRef, pa.processingAuthorityId);
  assert.equal(out.client.createdByMembershipId, operator.membershipId);
  assert.equal(out.client.archivedAt, undefined);
  assert.equal(out.event.eventType, "end_client.created.v1");
  assert.deepEqual(out.event.payload, { clientId, agencyId: ag.agencyId, processingAuthorityRef: pa.processingAuthorityId, createdByMembershipId: operator.membershipId });
  assert.ok(!JSON.stringify(out.event).includes("Client One"));
  const twin = createEndClient({ clientId: id() as ClientId, displayName: "Client One", processingAuthorityRef: pa.processingAuthorityId, now: NOW }, { agency: ag, actor: operator, processingAuthority: pa });
  assert.notEqual(twin.client.clientId, out.client.clientId);
  assert.equal(twin.client.displayName, out.client.displayName);
});

test("CMD009 guards: role boundary (OWNER/ADMIN/OPERATOR create; APPROVER/VIEWER/BILLING do not), agency open, foreign authority, label", () => {
  const w = world();
  const input = { clientId: id() as ClientId, displayName: "Client", processingAuthorityRef: w.pa.processingAuthorityId, now: NOW };
  for (const actor of [w.owner, w.admin, w.operator]) assert.equal(createEndClient(input, { agency: w.ag, actor, processingAuthority: w.pa }).client.state, "ACTIVE", actor.role);
  for (const actor of [w.approver, w.viewer, w.billing]) refused(() => createEndClient(input, { agency: w.ag, actor, processingAuthority: w.pa }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  refused(() => createEndClient(input, { agency: w.ag, actor: { ...w.operator, state: "SUSPENDED" }, processingAuthority: w.pa }), "NOT_AUTHORIZED", "MEMBERSHIP_SUSPENDED");
  refused(() => createEndClient(input, { agency: w.ag, actor: { ...w.operator, state: "INVITED" }, processingAuthority: w.pa }), "NOT_AUTHORIZED", "MEMBERSHIP_NOT_ACTIVE");
  // a member of another agency addressing this agency is not found (foreign and nonexistent look alike)
  const other = world();
  refused(() => createEndClient(input, { agency: w.ag, actor: other.operator, processingAuthority: w.pa }), "NOT_FOUND", "NOT_A_MEMBER");
  // DRAFT permits setup; RESTRICTED, CLOSING and CLOSED refuse (D-CMD-2)
  const draft = agency({ agencyId: w.ag.agencyId });
  assert.equal(createEndClient(input, { agency: draft, actor: w.operator, processingAuthority: w.pa }).client.state, "ACTIVE");
  for (const state of ["RESTRICTED", "CLOSING", "CLOSED"] as const) refused(() => createEndClient(input, { agency: activeAgency({ agencyId: w.ag.agencyId, state }), actor: w.operator, processingAuthority: w.pa }), "PRECONDITION_FAILED", "AGENCY_NOT_OPEN");
  // a foreign or unknown processing authority is an unknown reference; the composite foreign key is the second line
  const foreignAuthority = { ...other.pa, processingAuthorityId: w.pa.processingAuthorityId };
  for (const pa of [null, other.pa, foreignAuthority]) {
    const f = refused(() => createEndClient(input, { agency: w.ag, actor: w.operator, processingAuthority: pa }), "INVALID_REQUEST", "UNKNOWN_REFERENCE");
    assert.deepEqual(f.details.fields, [{ field: "processingAuthorityRef", code: "UNKNOWN_REFERENCE" }]);
  }
  const label = refused(() => createEndClient({ ...input, displayName: "x".repeat(201) }, { agency: w.ag, actor: w.operator, processingAuthority: w.pa }), "INVALID_REQUEST");
  assert.deepEqual(label.details.fields, [{ field: "displayName", code: "FORMAT" }]);
});

test("CMD010 archiveEndClient: the listed edge ACTIVE -> ARCHIVED at version + 1, reporting retained work; nothing else changes", () => {
  const { ag, admin, owner, operator, viewer } = world();
  const c = client(ag.agencyId, owner.membershipId, { version: 3 });
  const out = archiveEndClient({ client: c, expectedVersion: 3, actor: admin, agency: ag, openProjects: 2, now: at(7) });
  assert.equal(out.client.state, "ARCHIVED");
  assert.equal(out.client.version, 4);
  assert.equal(out.client.archivedAt, at(7));
  assert.equal(out.client.displayName, c.displayName);
  assert.equal(out.client.processingAuthorityRef, c.processingAuthorityRef);
  assert.equal(out.event.eventType, "end_client.archived.v1");
  assert.deepEqual(out.event.payload, { clientId: c.clientId, agencyId: ag.agencyId, openProjects: 2, archivedByMembershipId: admin.membershipId });
  assert.ok(!("deletionRequested" in out.client) && !("refund" in out.client), "archiving is neither a deletion nor a refund");
  // an ARCHIVED client refuses new projects and a second archive (reason CLIENT_ARCHIVED, design §8 CMD010)
  refused(() => assertClientActive(out.client), "PRECONDITION_FAILED", "CLIENT_ARCHIVED");
  const again = refused(() => archiveEndClient({ client: out.client, expectedVersion: 4, actor: admin, agency: ag, openProjects: 0, now: NOW }), "PRECONDITION_FAILED", "CLIENT_ARCHIVED");
  assert.equal(again.details.currentVersion, 4);
  // role boundary: OWNER and ADMIN archive; OPERATOR and VIEWER do not
  assert.equal(archiveEndClient({ client: c, expectedVersion: 3, actor: owner, agency: ag, openProjects: 0, now: NOW }).client.state, "ARCHIVED");
  refused(() => archiveEndClient({ client: c, expectedVersion: 3, actor: operator, agency: ag, openProjects: 0, now: NOW }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  refused(() => archiveEndClient({ client: c, expectedVersion: 3, actor: viewer, agency: ag, openProjects: 0, now: NOW }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  // stale version carries the current safe version and state (CMD010-DENY)
  const stale = refused(() => archiveEndClient({ client: c, expectedVersion: 2, actor: admin, agency: ag, openProjects: 0, now: NOW }), "STALE_VERSION");
  assert.deepEqual([stale.details.currentVersion, stale.details.currentState], [3, "ACTIVE"]);
  // a client of another agency is not found
  const other = world();
  refused(() => archiveEndClient({ client: client(other.ag.agencyId, other.owner.membershipId), expectedVersion: 1, actor: admin, agency: ag, openProjects: 0, now: NOW }), "NOT_FOUND", "CROSS_AGENCY");
  assert.throws(() => archiveEndClient({ client: c, expectedVersion: 3, actor: admin, agency: ag, openProjects: -1, now: NOW }), RangeError);
});

test("CMD011 createProject: OPEN project with its DRAFT revision, capability snapshot and two events; CLEAN needs no target", () => {
  const { ag, operator, owner } = world();
  const c = client(ag.agencyId, owner.membershipId);
  const cap = capability("CLEAN");
  const projectId = id() as ProjectId;
  const revisionId = id() as RevisionId;
  const out = createProject({ projectId, revisionId, mode: "CLEAN", purpose: "Quarterly cleanup", now: NOW }, { agency: ag, client: c, actor: operator, capability: cap });
  assert.equal(out.project.state, "OPEN");
  assert.equal(out.project.version, 1);
  assert.equal(out.project.clientId, c.clientId);
  assert.equal(out.project.agencyId, ag.agencyId);
  assert.equal(out.project.targetInstanceRef, undefined);
  assert.equal(out.project.capabilityId, cap.capabilityId);
  assert.equal(out.project.capabilityVersion, "R2-INITIAL");
  assert.equal(out.project.currentRevisionId, revisionId);
  assert.equal(out.revision.state, "DRAFT");
  assert.equal(out.revision.version, 1);
  assert.equal(out.revision.projectId, projectId);
  assert.deepEqual(out.revision.scope, { agencyId: ag.agencyId, clientId: c.clientId, projectId });
  assert.equal(out.revision.manifestHash, undefined, "a draft revision has no sealed manifest");
  assert.deepEqual(out.events.map((e) => e.eventType), ["project.created.v1", "dataset_revision.created.v1"]);
  assert.deepEqual(out.events[0]?.payload, { projectId, agencyId: ag.agencyId, clientId: c.clientId, mode: "CLEAN", capabilityId: cap.capabilityId, capabilityVersion: "R2-INITIAL", initialRevisionId: revisionId, createdByMembershipId: operator.membershipId });
  assert.deepEqual(out.events[1]?.payload, { revisionId, agencyId: ag.agencyId, projectId, state: "DRAFT" });
  assert.ok(!JSON.stringify(out.events).includes("Quarterly"));
  // CRM modes declare a target; the declaration claims no qualification
  const target = id();
  const hub = createProject({ projectId: id() as ProjectId, revisionId: id() as RevisionId, mode: "HUBSPOT", purpose: "Sync", targetInstanceRef: target, now: NOW }, { agency: ag, client: c, actor: operator, capability: capability("HUBSPOT", "AVAILABLE") });
  assert.equal(hub.project.targetInstanceRef, target);
});

test("CMD011 guards: archived client, agency not open, unoffered mode before any quote, target required for CRM modes, role boundary, invented mode", () => {
  const w = world();
  const c = client(w.ag.agencyId, w.owner.membershipId);
  const input = { projectId: id() as ProjectId, revisionId: id() as RevisionId, mode: "HUBSPOT", purpose: "Sync", targetInstanceRef: id(), now: NOW };
  const offered = capability("HUBSPOT");
  for (const actor of [w.owner, w.admin, w.operator]) assert.equal(createProject(input, { agency: w.ag, client: c, actor, capability: offered }).project.state, "OPEN", actor.role);
  for (const actor of [w.approver, w.viewer, w.billing]) refused(() => createProject(input, { agency: w.ag, client: c, actor, capability: offered }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  refused(() => createProject(input, { agency: w.ag, client: { ...c, state: "ARCHIVED", archivedAt: NOW, version: 2 }, actor: w.operator, capability: offered }), "PRECONDITION_FAILED", "CLIENT_ARCHIVED");
  for (const state of ["RESTRICTED", "CLOSING", "CLOSED"] as const) refused(() => createProject(input, { agency: activeAgency({ agencyId: w.ag.agencyId, state }), client: c, actor: w.operator, capability: offered }), "PRECONDITION_FAILED", "AGENCY_NOT_OPEN");
  // an unavailable mode is CAPABILITY_UNAVAILABLE before anything else could be quoted or charged
  for (const state of ["DESIGN", "IMPLEMENTED_UNACCEPTED", "QUALIFIED_INTERNAL", "SUSPENDED"] as const) {
    const f = refused(() => createProject(input, { agency: w.ag, client: c, actor: w.operator, capability: capability("HUBSPOT", state) }), "CAPABILITY_UNAVAILABLE", "MODE_NOT_OFFERED");
    assert.equal(f.status, 422);
  }
  refused(() => createProject(input, { agency: w.ag, client: c, actor: w.operator, capability: null }), "CAPABILITY_UNAVAILABLE", "MODE_NOT_OFFERED");
  refused(() => createProject(input, { agency: w.ag, client: c, actor: w.operator, capability: capability("SALESFORCE") }), "CAPABILITY_UNAVAILABLE", "CAPABILITY_MODE_MISMATCH");
  refused(() => createProject(input, { agency: w.ag, client: c, actor: w.operator, capability: capability("HUBSPOT", "AVAILABLE", { version: "1.0.0" }) }), "INTEGRITY_FAILURE");
  // HUBSPOT/SALESFORCE need a declared target; CLEAN does not
  const { targetInstanceRef: _t, ...noTarget } = input;
  const missing = refused(() => createProject(noTarget, { agency: w.ag, client: c, actor: w.operator, capability: offered }), "INVALID_REQUEST", "TARGET_INSTANCE_REQUIRED");
  assert.deepEqual(missing.details.fields, [{ field: "targetInstanceRef", code: "REQUIRED" }]);
  refused(() => createProject({ ...noTarget, mode: "SALESFORCE" }, { agency: w.ag, client: c, actor: w.operator, capability: capability("SALESFORCE") }), "INVALID_REQUEST", "TARGET_INSTANCE_REQUIRED");
  const badRef = refused(() => createProject({ ...input, targetInstanceRef: "portal-123" }, { agency: w.ag, client: c, actor: w.operator, capability: offered }), "INVALID_REQUEST");
  assert.deepEqual(badRef.details.fields, [{ field: "targetInstanceRef", code: "FORMAT" }]);
  const invented = refused(() => createProject({ ...input, mode: "PIPEDRIVE" }, { agency: w.ag, client: c, actor: w.operator, capability: offered }), "INVALID_REQUEST");
  assert.deepEqual(invented.details.fields, [{ field: "mode", code: "ENUM" }]);
  assert.ok(isServiceMode("CLEAN") && isServiceMode("HUBSPOT") && isServiceMode("SALESFORCE") && !isServiceMode("clean"));
  const purpose = refused(() => createProject({ ...input, purpose: "" }, { agency: w.ag, client: c, actor: w.operator, capability: offered }), "INVALID_REQUEST");
  assert.deepEqual(purpose.details.fields, [{ field: "purpose", code: "FORMAT" }]);
  // a client of another agency is not found
  const other = world();
  refused(() => createProject(input, { agency: w.ag, client: client(other.ag.agencyId, other.owner.membershipId), actor: w.operator, capability: offered }), "NOT_FOUND", "CROSS_AGENCY");
});

test("platform machines EndClient (D-AGG-2) and Project (D-AGG-1) obey the registry's unlisted-transition policy", () => {
  assert.deepEqual(PLATFORM_STATE_MACHINES.map((m) => m.contract), ["EndClient", "Project"]);
  for (const m of PLATFORM_STATE_MACHINES) assert.equal(m.unlistedTransition, "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED");
  assert.deepEqual([...statesOf("EndClient")].sort(), ["ACTIVE", "ARCHIVED"]);
  assert.equal(transition("EndClient", "ACTIVE", "archive_client"), "ARCHIVED");
  refused(() => transition("EndClient", "ARCHIVED", "archive_client"), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
  assert.deepEqual([...statesOf("Project")].sort(), ["CLOSED", "DELETED", "DELETION_REQUESTED", "OPEN"]);
  assert.deepEqual([...eventsOf("Project")].sort(), ["close_project", "deletion_verified", "request_deletion"]);
  assert.equal(transition("Project", "OPEN", "close_project"), "CLOSED");
  assert.equal(transition("Project", "OPEN", "request_deletion"), "DELETION_REQUESTED");
  assert.equal(transition("Project", "CLOSED", "request_deletion"), "DELETION_REQUESTED");
  assert.equal(transition("Project", "DELETION_REQUESTED", "deletion_verified"), "DELETED");
  let refusedPairs = 0;
  const listed = new Set(["OPEN/close_project", "OPEN/request_deletion", "CLOSED/request_deletion", "DELETION_REQUESTED/deletion_verified"]);
  for (const s of statesOf("Project")) for (const e of eventsOf("Project")) if (!listed.has(`${s}/${e}`)) { refused(() => transition("Project", s, e), "PRECONDITION_FAILED", "UNLISTED_TRANSITION"); refusedPairs += 1; }
  assert.equal(refusedPairs, 4 * 3 - 4);
});

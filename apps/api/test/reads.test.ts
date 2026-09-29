// The manual-10 agency, team, client and project reads (re-check finding N16; prompts/B06 "role-specific safe DTOs"; 10
// "Agency and team routes", "Client and project routes", "Pagination, search and exports"; registry R2-060 "Reject cursor scope/signature
// mismatch without leaking rows or totals"; S048 "Deny without resource-existence or data leakage"). Real routes, real
// composition root, real PostgreSQL 17 under the request handlers' own role and policies.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgencyMembershipView, AgencyView, EndClientView, Page, ProjectView, TeamMemberView } from "@kauro/application";
import { READ_OUTCOMES, ResponseContractViolation, checkReply, problemOf, readRouteResponses } from "@kauro/application";
import type { AgencyId, ProjectId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { approvalBodyOf, asProblem, call, completed, effectCounts, ids, outcome, routes, world, type Person, type Reply, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

const paths = {
  agencies: () => "/api/v1/agencies",
  agency: (agencyId: string) => `/api/v1/agencies/${agencyId}`,
  members: (agencyId: string) => `/api/v1/agencies/${agencyId}/members`,
  clients: (agencyId: string) => `/api/v1/agencies/${agencyId}/clients`,
  project: (projectId: string) => `/api/v1/projects/${projectId}`,
};

/** A GET as `person` (no body, no idempotency key); `agency` is the X-Kauro-Agency selector when the read takes one. */
function read(url: string, person: Person | null, agency: string | null = null): Promise<Reply> {
  return call(w, { method: "GET", url, token: person === null ? null : person.token, key: null, contentType: null, agency });
}

function data<T>(reply: Reply): T {
  if (reply.status !== 200) throw new Error(`expected 200, got ${reply.status}: ${reply.text}`);
  const body = reply.json<{ kind: string; data: T }>();
  assert.equal(body.kind, "READ");
  return body.data;
}

async function factOf(reply: Reply): Promise<{ action: string; reason: string | null; agencyId: string | null; requestedAgencyId: string | null } | null> {
  const r = await w.h.oracle.query<{ action: string; reason_code: string | null; agency_id: string | null; requested_agency_id: string | null }>(
    "SELECT action, reason_code, agency_id, requested_agency_id FROM kauro.security_events WHERE correlation_id = $1",
    [String(reply.headers["x-correlation-id"])],
  );
  const row = r.rows[0];
  return row ? { action: row.action, reason: row.reason_code, agencyId: row.agency_id, requestedAgencyId: row.requested_agency_id } : null;
}

test("N16 ListAgencies: GET /agencies lists only the caller's actual memberships — ACTIVE with its capabilities, SUSPENDED with none, never an INVITED one or another person's — and pages them with a cursor bound to the caller", async () => {
  const own = data<Page<AgencyMembershipView>>(await read(paths.agencies(), w.owner));
  assert.deepEqual(own.items.map((i) => [i.agencyId, i.role, i.membershipState]), [[w.A.agencyId, "OWNER", "ACTIVE"]]);
  assert.ok(own.items[0]!.permittedActions.includes("MANAGE_TEAM"));
  const suspended = data<Page<AgencyMembershipView>>(await read(paths.agencies(), w.suspended));
  assert.deepEqual(suspended.items.map((i) => [i.agencyId, i.membershipState, i.permittedActions]), [[w.A.agencyId, "SUSPENDED", []]]);
  assert.deepEqual(data<Page<AgencyMembershipView>>(await read(paths.agencies(), w.invited)).items, [], "an invitation is not a membership yet");
  // three memberships, pages of two: the second page is reached only by the first page's cursor, and only by its caller
  const roamer = await w.person("n16-roamer");
  const C = await w.h.createAgency((await w.person("n16-third-owner")).userId, "Charlie Agency");
  for (const agency of [w.A, w.B, C]) await w.h.addMember(agency, roamer.userId, "VIEWER");
  const first = data<Page<AgencyMembershipView>>(await read(`${paths.agencies()}?limit=2`, roamer));
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor !== undefined);
  const second = data<Page<AgencyMembershipView>>(await read(`${paths.agencies()}?limit=2&cursor=${first.nextCursor}`, roamer));
  assert.deepEqual([...first.items, ...second.items].map((i) => i.agencyId).sort(), [w.A.agencyId, w.B.agencyId, C.agencyId].sort());
  assert.equal(second.nextCursor, undefined, "a page shorter than its limit is the last");
  const stolen = await read(`${paths.agencies()}?limit=2&cursor=${first.nextCursor}`, w.owner);
  assert.equal(outcome(w, stolen), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.ok(!stolen.text.includes(w.B.agencyId) && !stolen.text.includes(C.agencyId), "nothing of the other caller's scope");
});

test("N16 GetAgency: the safe agency view for every ACTIVE member with its own capabilities; a foreign and a nonexistent agency answer the same 404 with the denial recorded in the caller's own stream; SUSPENDED, INVITED and unauthenticated callers are refused", async () => {
  const asOwner = data<AgencyView>(await read(paths.agency(w.A.agencyId), w.owner));
  assert.equal(asOwner.agencyId, w.A.agencyId);
  assert.ok(asOwner.version >= 1);
  assert.ok(asOwner.permittedActions.includes("MANAGE_AGENCY"));
  assert.deepEqual(data<AgencyView>(await read(paths.agency(w.A.agencyId), w.viewer)).permittedActions, ["VIEW"]);
  assert.deepEqual([...data<AgencyView>(await read(paths.agency(w.A.agencyId), w.billing)).permittedActions].sort(), ["MANAGE_BILLING", "VIEW"]);
  // S048: a foreign agency and one that does not exist look alike
  const foreign = await read(paths.agency(w.A.agencyId), w.stranger);
  const nowhere = await read(paths.agency(ids.next()), w.stranger);
  for (const reply of [foreign, nowhere]) assert.equal(outcome(w, reply), "404 NOT_FOUND NOT_A_MEMBER");
  const { correlationId: _a, ...foreignRest } = asProblem(w, foreign);
  const { correlationId: _b, ...nowhereRest } = asProblem(w, nowhere);
  assert.deepEqual(foreignRest, nowhereRest, "the answers differ only in their correlation ids");
  assert.deepEqual(await factOf(foreign), { action: "GET_AGENCY", reason: "NOT_A_MEMBER", agencyId: null, requestedAgencyId: w.A.agencyId });
  assert.equal(outcome(w, await read(paths.agency(w.A.agencyId), w.suspended)), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(outcome(w, await read(paths.agency(w.A.agencyId), w.invited)), "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE");
  const anonymous = await read(paths.agency(w.A.agencyId), null);
  assert.equal(outcome(w, anonymous), "401 AUTHENTICATION_REQUIRED -");
  assert.deepEqual(await factOf(anonymous), { action: "GET_AGENCY", reason: "SUBJECT_UNAUTHENTICATED", agencyId: null, requestedAgencyId: w.A.agencyId });
  assert.equal(outcome(w, await read(`${paths.agency(w.A.agencyId)}?limit=2`, w.owner)), "400 INVALID_REQUEST SCHEMA_VIOLATION", "a read without a list takes no query");
  assert.equal(outcome(w, await read(paths.agency("not-an-id"), w.owner)), "400 INVALID_REQUEST PATH_ID_INVALID");
});

test("N16 ListMembers: team information appropriate to the caller — a team manager sees every membership with its lifecycle times, any other member only the ACTIVE team's roles; nobody sees another person's identity reference, assurance policy or security evidence", async () => {
  const managed = data<Page<TeamMemberView>>(await read(paths.members(w.A.agencyId), w.admin));
  const states = new Set(managed.items.map((m) => m.state));
  assert.ok(states.has("SUSPENDED") && states.has("INVITED") && states.has("ACTIVE"), `the manager sees every state: ${[...states].join(",")}`);
  assert.ok(managed.items.every((m) => typeof m.createdAt === "string"));
  assert.deepEqual(managed.items.filter((m) => m.self).map((m) => m.membershipId), [w.memberships.admin]);
  for (const person of [w.viewer, w.operator, w.billing, w.approver]) {
    const team = data<Page<TeamMemberView>>(await read(paths.members(w.A.agencyId), person));
    assert.ok(team.items.every((m) => m.state === "ACTIVE" && m.createdAt === undefined && m.acceptedAt === undefined), "only the ACTIVE team's roles");
    assert.equal(team.items.filter((m) => m.self).length, 1);
    assert.ok(team.items.length < managed.items.length);
  }
  // no reply names any person's identity reference or security configuration
  const everyone = [w.owner, w.admin, w.operator, w.approver, w.approver2, w.viewer, w.billing, w.suspended, w.invited];
  for (const person of [w.admin, w.viewer]) {
    const text = (await read(paths.members(w.A.agencyId), person)).text;
    for (const other of everyone) assert.ok(!text.includes(other.userId), "no userId on the wire");
    for (const forbidden of ["userId", "assurancePolicy", "emailVerifiedAt", "mfaEnrolledAt", "subjectHash", "token"]) assert.ok(!text.includes(`"${forbidden}"`), forbidden);
  }
  // pages of two, in (createdAt, membershipId) order, reach every membership exactly once
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page: Page<TeamMemberView> = data<Page<TeamMemberView>>(await read(`${paths.members(w.A.agencyId)}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, w.owner));
    seen.push(...page.items.map((m) => m.membershipId));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.deepEqual([...seen].sort(), managed.items.map((m) => m.membershipId).sort());
  // the team of another agency is not the caller's to read
  assert.equal(outcome(w, await read(paths.members(w.B.agencyId), w.admin)), "404 NOT_FOUND NOT_A_MEMBER");
});

test("N16 ListClients and R2-060: safe client summaries with each caller's permitted actions, pages bound to the caller, the agency and the list — a cursor of agency A presented for agency B, by another caller, edited, or of another list is CURSOR_INVALID without a row or a total", async () => {
  for (let i = 0; i < 3; i++) await w.h.endClient(w.A, w.authorityA, `N16 client ${i}`);
  const byOwner = data<Page<EndClientView>>(await read(paths.clients(w.A.agencyId), w.owner));
  assert.ok(byOwner.items.length >= 4);
  assert.deepEqual(byOwner.items.find((c) => c.clientId === w.clientA)?.permittedActions, ["ArchiveClient", "CreateProject"]);
  assert.deepEqual(data<Page<EndClientView>>(await read(paths.clients(w.A.agencyId), w.operator)).items.find((c) => c.clientId === w.clientA)?.permittedActions, ["CreateProject"]);
  assert.deepEqual(data<Page<EndClientView>>(await read(paths.clients(w.A.agencyId), w.viewer)).items.find((c) => c.clientId === w.clientA)?.permittedActions, []);
  // limits: the policy's default and maximum
  assert.equal(outcome(w, await read(`${paths.clients(w.A.agencyId)}?limit=101`, w.owner)), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await read(`${paths.clients(w.A.agencyId)}?limit=0`, w.owner)), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await read(`${paths.clients(w.A.agencyId)}?limit=2&limit=3`, w.owner)), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await read(`${paths.clients(w.A.agencyId)}?state=ACTIVE`, w.owner)), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  // a member of both agencies: the cursor of A's list is not a cursor of B's
  const both = await w.person("n16-both");
  await w.h.addMember(w.A, both.userId, "VIEWER");
  await w.h.addMember(w.B, both.userId, "VIEWER");
  const pageA = data<Page<EndClientView>>(await read(`${paths.clients(w.A.agencyId)}?limit=2`, both));
  assert.ok(pageA.nextCursor !== undefined);
  const before = await effectCounts(w);
  const crossTenant = await read(`${paths.clients(w.B.agencyId)}?limit=2&cursor=${pageA.nextCursor}`, both);
  assert.equal(outcome(w, crossTenant), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.ok(!crossTenant.text.includes(w.clientB) && !crossTenant.text.includes("items") && !/"total/.test(crossTenant.text), "no row and no total");
  assert.deepEqual(await effectCounts(w), before, "nothing written by a refused read");
  // the same cursor by another member of A, on another list, or edited
  assert.equal(outcome(w, await read(`${paths.clients(w.A.agencyId)}?limit=2&cursor=${pageA.nextCursor}`, w.owner)), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.equal(outcome(w, await read(`${paths.members(w.A.agencyId)}?limit=2&cursor=${pageA.nextCursor}`, both)), "400 INVALID_REQUEST CURSOR_INVALID");
  const [position, mac] = pageA.nextCursor.split(".") as [string, string];
  const edited = `${position.slice(0, -2)}${position.endsWith("A") ? "B" : "A"}${position.slice(-1)}.${mac}`;
  assert.equal(outcome(w, await read(`${paths.clients(w.A.agencyId)}?limit=2&cursor=${edited}`, both)), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.equal(outcome(w, await read(`${paths.clients(w.A.agencyId)}?limit=2&cursor=not-a-cursor`, both)), "400 INVALID_REQUEST CURSOR_INVALID");
  // the genuine continuation still works for its caller
  const pageA2 = data<Page<EndClientView>>(await read(`${paths.clients(w.A.agencyId)}?limit=2&cursor=${pageA.nextCursor}`, both));
  assert.ok(pageA2.items.every((c) => !pageA.items.some((p) => p.clientId === c.clientId)), "the next page continues after the first");
});

test("N16 GetProject: the project with its current revision summary, its readiness blockers and no permitted action of this edition, under the agency selector; another agency's project answers the same 404 as one that does not exist", async () => {
  const project = await w.project(w.A, w.clientA);
  const view = data<ProjectView>(await read(paths.project(project.projectId), w.viewer, w.A.agencyId));
  assert.equal(view.projectId, project.projectId);
  assert.equal(view.currentRevision.state, "DRAFT");
  assert.ok(view.readinessBlockers.includes("NO_SEALED_REVISION") && view.readinessBlockers.includes("PLAN_MISSING") && view.readinessBlockers.includes("TARGET_CONTRACT_MISSING"));
  assert.deepEqual(view.permittedActions, []);
  // once a plan is VALIDATED against a sealed source and a confirmed target, the blockers say so
  await w.approvable(w.A, project.projectId, "n16-project-read");
  const progressed = data<ProjectView>(await read(paths.project(project.projectId), w.viewer, w.A.agencyId));
  assert.ok(progressed.readinessBlockers.includes("PLAN_NOT_APPROVED") && !progressed.readinessBlockers.includes("PLAN_MISSING") && !progressed.readinessBlockers.includes("TARGET_CONTRACT_MISSING"), progressed.readinessBlockers.join(","));
  const foreign = await read(paths.project(project.projectId), w.stranger, w.B.agencyId);
  const nowhere = await read(paths.project(ids.next() as ProjectId), w.stranger, w.B.agencyId);
  for (const reply of [foreign, nowhere]) assert.equal(outcome(w, reply), "404 NOT_FOUND -");
  assert.equal(outcome(w, await read(paths.project(project.projectId), w.viewer, null)), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(outcome(w, await read(paths.project(project.projectId), w.stranger, w.A.agencyId)), "404 NOT_FOUND NOT_A_MEMBER");
});

test("N16 permitted actions on the command replies: derived from the caller's role, the resource's state and the approval's control", async () => {
  const byOperator = completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), token: w.operator.token, agency: null, body: { displayName: "N16 by operator", processingAuthorityRef: w.authorityA } }), 201);
  assert.deepEqual(byOperator.data.permittedActions, ["CreateProject"]);
  const byAdmin = completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), token: w.admin.token, agency: null, body: { displayName: "N16 by admin", processingAuthorityRef: w.authorityA } }), 201);
  assert.deepEqual(byAdmin.data.permittedActions, ["ArchiveClient", "CreateProject"]);
  const archived = completed<{ client: EndClientView }>(await call(w, { url: routes.archiveClient(byAdmin.data.clientId), token: w.admin.token, body: { expectedVersion: 1 } }), 200);
  assert.deepEqual(archived.data.client.permittedActions, []);
  const projectId = (await w.project(w.A, w.clientA)).projectId;
  const plan = await w.approvable(w.A, projectId, "n16-actions");
  const approved = completed<{ approval: { permittedActions: string[] }; plan: { permittedActions: string[] } }>(await call(w, { url: routes.approvePlan(plan.planId), token: w.owner.token, body: approvalBodyOf(plan, await w.stepUp(w.owner)) }), 201);
  assert.deepEqual(approved.data.approval.permittedActions, ["WithdrawApproval"]);
  assert.deepEqual(approved.data.plan.permittedActions, ["RevisePlan", "WithdrawApproval"], "an OWNER controls the approval it made and may revise or withdraw");
  const withdrawn = completed<{ approval: { permittedActions: string[] }; plan: { permittedActions: string[] } }>(await call(w, { url: routes.withdrawApproval(plan.planId), token: w.owner.token, body: { expectedVersion: 5, reasonCode: "N16" } }), 200);
  assert.deepEqual([withdrawn.data.approval.permittedActions, withdrawn.data.plan.permittedActions], [[], []]);
  const revisable = await w.approvable(w.A, projectId, "n16-actions-revise");
  const revised = completed<{ plan: { permittedActions: string[] } }>(await call(w, { url: routes.revisePlan(revisable.planId), token: w.operator.token, body: { expectedVersion: revisable.version, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "N16" }) } }), 201);
  assert.deepEqual(revised.data.plan.permittedActions, ["RevisePlan"], "an OPERATOR may revise the VALIDATION_REQUIRED successor, never approve it");
});

test("N16: every read answers only the outcomes of its catalogue — each listed problem passes its route's send guard and an unlisted one is refused", () => {
  for (const [operationId, outcomes] of Object.entries(READ_OUTCOMES) as Array<[keyof typeof READ_OUTCOMES, (typeof READ_OUTCOMES)[keyof typeof READ_OUTCOMES]]>) {
    const contract = readRouteResponses(operationId);
    for (const entry of outcomes) {
      const problem = problemOf(new DomainFailure(entry.code, "probe", { ...(entry.reason !== null ? { reason: entry.reason } : {}), ...(entry.fieldCodes ? { fields: [{ field: "query.limit", code: entry.fieldCodes[0]! }] } : {}) }), ids.next());
      checkReply(w.validator, contract, problem.status, "application/problem+json", problem);
    }
    for (const [code, reason] of [["STALE_VERSION", undefined], ["IDEMPOTENCY_CONFLICT", "REQUEST_DIGEST_DIFFERS"], ["NOT_AUTHORIZED", "ROLE_INSUFFICIENT"]] as const) {
      const problem = problemOf(new DomainFailure(code, "probe", reason !== undefined ? { reason } : {}), ids.next());
      assert.throws(() => checkReply(w.validator, contract, problem.status, "application/problem+json", problem), (e: unknown) => e instanceof ResponseContractViolation, `${operationId} ${code}`);
    }
  }
  assert.ok(Object.keys(READ_OUTCOMES).length === 7 && (w.A.agencyId as AgencyId).length > 0);
});

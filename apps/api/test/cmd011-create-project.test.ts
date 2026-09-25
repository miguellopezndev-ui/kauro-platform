// CMD011 CreateProject — POST /api/v1/clients/{clientId}/projects — AGENCY_OPERATOR (registry cases CMD011-OK / -DENY /
// -RACE; design §8, D-CMD-4; catalogue precondition "The client is active; the requested mode is offered and target scope is
// declared without claiming qualification"; failure "An unavailable mode returns CAPABILITY_UNAVAILABLE before quoting or
// charging"; effect "Create a project with a draft revision and visible readiness blockers"). Real route, adapters, oracle.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ArchiveClientView, EndClientView, ProjectView } from "@kauro/application";
import type { ClientId } from "@kauro/domain";
import type { AgencyFixture } from "@kauro/persistence";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, rawEvent, rootCause, routes, sha, waitForApiLockWait, world, type World } from "./support.js";
import { controlWriter, reachedHold, tenantWriter, waitForWriterLockWait, type HeldTransaction } from "./writers.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

async function freshClient(label: string): Promise<ClientId> {
  const created = completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), agency: null, body: { displayName: label, processingAuthorityRef: w.authorityA } }), 201);
  return created.data.clientId as ClientId;
}

test("OK: an OPERATOR creates a CLEAN project on an ACTIVE client with an offered capability; the response lists readiness blockers", async () => {
  const key = freshKey("cmd011-ok");
  const created = completed<ProjectView>(await call(w, { url: routes.createProject(w.clientA), token: w.operator.token, key, body: { mode: "CLEAN", purpose: "Dedupe contacts" } }), 201);
  assert.equal(created.version, 1);
  assert.equal(created.replayed, false);
  const view = created.data;
  assert.equal(view.state, "OPEN");
  assert.equal(view.version, 1);
  assert.equal(view.mode, "CLEAN");
  assert.equal(view.purpose, "Dedupe contacts");
  assert.equal(view.targetInstanceRef, undefined);
  assert.equal(view.clientId, w.clientA);
  assert.equal(view.agencyId, w.A.agencyId);
  assert.equal(view.capabilityVersion, "R2-INITIAL");
  assert.deepEqual(view.currentRevision, { revisionId: view.currentRevision.revisionId, state: "DRAFT", version: 1 });
  // the blockers are computed from durable facts: DRAFT agency, unsealed revision, no target contract, no plan
  assert.deepEqual(view.readinessBlockers, ["AGENCY_NOT_ACTIVE", "NO_SEALED_REVISION", "TARGET_CONTRACT_MISSING", "PLAN_MISSING"]);
  assert.ok(view.readinessBlockers.includes("NO_SEALED_REVISION"));

  // oracle: the project row and its draft revision, bound by current_revision_id (deferred key), one event each
  const project = await w.row<{ agency_id: string; client_id: string; state: string; version: string; capability_id: string; capability_version: string; current_revision_id: string; created_by_membership_id: string; target_instance_ref: string | null }>("projects", "project_id = $1", [view.projectId]);
  assert.deepEqual(project && { agency: project.agency_id, client: project.client_id, state: project.state, version: project.version, capability: project.capability_id, capabilityVersion: project.capability_version, revision: project.current_revision_id, by: project.created_by_membership_id, target: project.target_instance_ref }, {
    agency: w.A.agencyId,
    client: w.clientA,
    state: "OPEN",
    version: "1",
    capability: w.cleanCapabilityId,
    capabilityVersion: "R2-INITIAL",
    revision: view.currentRevision.revisionId,
    by: w.memberships.operator,
    target: null,
  });
  const revision = await w.row<{ project_id: string; state: string; version: string; manifest_hash: string | null }>("dataset_revisions", "revision_id = $1", [view.currentRevision.revisionId]);
  assert.deepEqual(revision && { project: revision.project_id, state: revision.state, version: revision.version, manifest: revision.manifest_hash }, { project: view.projectId, state: "DRAFT", version: "1", manifest: null });
  assert.deepEqual((await w.events("project", view.projectId)).map((e) => [e.version, e.type]), [[1, "project.created.v1"]]);
  assert.deepEqual((await w.events("dataset_revision", view.currentRevision.revisionId)).map((e) => [e.version, e.type]), [[1, "dataset_revision.created.v1"]]);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "project", id: view.projectId });
  assert.deepEqual(journal?.body, view);
});

test("DENY: foreign/wrong role → 404/403; HUBSPOT with no offered capability → 422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED; HUBSPOT without targetInstanceRef → 400; archived client → 409", async () => {
  const projectsBefore = await w.count("projects");
  const revisionsBefore = await w.count("dataset_revisions");
  const journalBefore = await w.count("command_journal");
  const denialsBefore = (await w.securityEvents("CMD011")).length;
  const url = routes.createProject(w.clientA);
  const body = { mode: "CLEAN", purpose: "Denied" };

  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, agency: w.B.agencyId, body })), "404 NOT_FOUND -", "A's client is invisible under B's context");
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, body })), "404 NOT_FOUND NOT_A_MEMBER", "the stranger has no membership in A");
  assert.equal(outcome(w, await call(w, { url: routes.createProject(w.clientB), token: w.operator.token, body })), "404 NOT_FOUND -", "B's client is invisible under A's context");
  for (const person of [w.viewer, w.approver]) {
    assert.equal(outcome(w, await call(w, { url, token: person.token, body })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  assert.equal(outcome(w, await call(w, { url, token: w.suspended.token, body })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");

  // HUBSPOT exists only as a DESIGN capability: not offered, refused before any quote or charge could exist
  const unoffered = await call(w, { url, token: w.operator.token, body: { mode: "HUBSPOT", purpose: "Import", targetInstanceRef: ids.next() } });
  assert.equal(outcome(w, unoffered), "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED");
  assert.deepEqual(asProblem(w, unoffered).nextActions, [{ action: "CHOOSE_ANOTHER_MODE" }]);
  const unknownMode = await call(w, { url, token: w.operator.token, body: { mode: "SALESFORCE", purpose: "Import", targetInstanceRef: ids.next() } });
  assert.equal(outcome(w, unknownMode), "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED", "a mode with no capability row at all");

  // publication is the capability's own lifecycle (D-CAP-2; registry machine Capability, initial DESIGN): the database refuses
  // the shortcuts — an unlisted edge DESIGN -> AVAILABLE_LIMITED (KA008), a row born offered under any revision label (KA008:
  // every capability is born DESIGN) and a second HUBSPOT row for the same revision (capabilities_mode_version) — so the
  // control plane moves the existing row along the listed edges, citing each gate's evidence. Implemented and internally
  // qualified are still not offered ("Requested, implemented and qualified are different states"): the mode stays refused
  // until AVAILABLE_LIMITED.
  const control = await w.h.pg.connect("kauro_control_test");
  try {
    await assert.rejects(
      control.query("UPDATE kauro.capabilities SET state = 'AVAILABLE_LIMITED', qualification_evidence_hashes = $2::jsonb WHERE capability_id = $1", [w.hubspotCapabilityId, JSON.stringify([sha("shortcut")])]),
      (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "KA008",
    );
    const bornAs = (version: string, state: string) =>
      control.query(
        `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
         VALUES ($1, $2, 'MODE', 'HUBSPOT', $3, $4, $5::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
        [ids.next(), version, state, sha("profile-HUBSPOT"), JSON.stringify(state === "DESIGN" ? [] : [sha("shortcut")])],
      );
    for (const version of ["R2-INITIAL", "R2-SHORTCUT"]) {
      await assert.rejects(bornAs(version, "AVAILABLE_LIMITED"), (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "KA008", `born offered under ${version}`);
    }
    await assert.rejects(
      bornAs("R2-INITIAL", "DESIGN"),
      (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505" && (e as { constraint?: string }).constraint === "capabilities_mode_version",
    );
  } finally {
    await control.end();
  }
  const hubspotBody = { mode: "HUBSPOT", purpose: "Import", targetInstanceRef: ids.next() };
  for (const state of ["IMPLEMENTED_UNACCEPTED", "QUALIFIED_INTERNAL"] as const) {
    await w.h.publishCapability(w.hubspotCapabilityId, state);
    assert.equal(outcome(w, await call(w, { url, token: w.operator.token, body: hubspotBody })), "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED", `HUBSPOT ${state} is not offered`);
  }
  await w.h.publishCapability(w.hubspotCapabilityId, "AVAILABLE_LIMITED");
  const published = await w.row<{ state: string; version: string; qualification_evidence_hashes: string[]; valid_from: Date | null }>("capabilities", "capability_id = $1", [w.hubspotCapabilityId]);
  assert.deepEqual(published && { state: published.state, version: published.version, evidence: published.qualification_evidence_hashes.length, activated: published.valid_from !== null }, { state: "AVAILABLE_LIMITED", version: "R2-INITIAL", evidence: 2, activated: true });
  assert.equal(await w.count("capabilities", "mode = 'HUBSPOT'"), 1, "one HUBSPOT capability row: the publication moved it");
  // once HUBSPOT is offered, a CRM project must still declare its target instance (D-CMD-4)
  const noTarget = await call(w, { url, token: w.operator.token, body: { mode: "HUBSPOT", purpose: "Import" } });
  assert.equal(outcome(w, noTarget), "400 INVALID_REQUEST TARGET_INSTANCE_REQUIRED");
  assert.deepEqual(asProblem(w, noTarget).errors, [{ field: "targetInstanceRef", code: "REQUIRED" }]);

  // an archived client accepts no new project
  const archived = await freshClient("Archived Client");
  completed<ArchiveClientView>(await call(w, { url: routes.archiveClient(archived), token: w.admin.token, body: { expectedVersion: 1 } }), 200);
  const onArchived = await call(w, { url: routes.createProject(archived), token: w.operator.token, body });
  assert.equal(outcome(w, onArchived), "409 PRECONDITION_FAILED CLIENT_ARCHIVED");
  assert.deepEqual(asProblem(w, onArchived).current, { version: 2, state: "ARCHIVED" });

  // oracle: zero projects and revisions from any denied call; no journal row; the authorization denials are durable facts
  assert.equal(await w.count("projects"), projectsBefore);
  assert.equal(await w.count("dataset_revisions"), revisionsBefore);
  assert.equal(await w.count("command_journal"), journalBefore + 2, "only the two fixture commands (client creation and archive) journaled");
  const denials = (await w.securityEvents("CMD011")).slice(denialsBefore);
  assert.deepEqual(denials.map((d) => d.reason).sort(), ["MEMBERSHIP_SUSPENDED", "NOT_A_MEMBER", "ROLE_INSUFFICIENT", "ROLE_INSUFFICIENT"]);
  // the declared HUBSPOT project, with its target, is admitted now that the mode is offered: the declaration claims no
  // qualification — the readiness blockers say so
  const hubspot = completed<ProjectView>(await call(w, { url, token: w.operator.token, body: { mode: "HUBSPOT", purpose: "Import", targetInstanceRef: ids.next() } }), 201);
  assert.ok(hubspot.data.targetInstanceRef);
  assert.deepEqual(hubspot.data.readinessBlockers, ["AGENCY_NOT_ACTIVE", "NO_SEALED_REVISION", "TARGET_CONTRACT_MISSING", "PLAN_MISSING"]);
});

test("RACE: identical retry replays; conflicting same key → 409; crash after the project insert and before the revision insert commits nothing (deferred FK)", async () => {
  const url = routes.createProject(w.clientA);
  const key = freshKey("cmd011-race");
  const body = { mode: "CLEAN", purpose: "Raced project" };
  // two identical requests: A reserves and holds, B waits on the identity index, A commits, B replays
  const hold = w.holds.arm("journal.reserved");
  const requestA = call(w, { url, token: w.operator.token, key, body });
  await hold.reached;
  const requestB = call(w, { url, token: w.operator.token, key, body });
  await waitForApiLockWait(w, "command_journal");
  hold.release();
  const [a, b] = await Promise.all([requestA, requestB]);
  const first = completed<ProjectView>(a, 201);
  const second = completed<ProjectView>(b, 201);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(await w.count("projects", "purpose = $1", ["Raced project"]), 1);
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [key]), 1);
  // conflicting same key
  const conflict = await call(w, { url, token: w.operator.token, key, body: { ...body, purpose: "Raced project (edited)" } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("projects", "purpose LIKE $1", ["Raced project%"]), 1);

  // crash at the commit boundary: project and revision rows and events were written, the journal was about to complete
  const crashKey = freshKey("cmd011-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url, token: w.operator.token, key: crashKey, body: { mode: "CLEAN", purpose: "Crashed project" } });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.equal(await w.count("projects", "purpose = $1", ["Crashed project"]), 0);
  assert.equal(await w.journal(crashKey), null);

  // a project can never exist without its draft revision: a project row inserted alone (a crash between the two inserts of
  // the pair, replayed as the runtime role under the tenant context) fails the deferred key at COMMIT and nothing persists
  const orphanId = ids.next();
  await assert.rejects(
    w.asTenant(w.A, async (c) => {
      await c.query(
        `INSERT INTO kauro.projects (project_id, agency_id, client_id, mode, purpose, capability_id, capability_version, current_revision_id, created_by_membership_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'CLEAN', 'Orphan project', $4, 'R2-INITIAL', $5, $6, now(), now())`,
        [orphanId, w.A.agencyId, w.clientA, w.cleanCapabilityId, ids.next(), w.A.ownerMembershipId],
      );
      await rawEvent(c, { aggregateKind: "project", aggregateId: orphanId, aggregateVersion: 1, agencyId: w.A.agencyId, eventType: "project.created.v1", actorUserId: w.owner.userId, payload: { projectId: orphanId, agencyId: w.A.agencyId, clientId: w.clientA, mode: "CLEAN" } });
    }),
    (e: unknown) => typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "23503" && (e as { constraint?: string }).constraint === "projects_current_revision_fk",
  );
  assert.equal(await w.count("projects", "project_id = $1", [orphanId]), 0);
  assert.equal(await w.count("projects", "NOT EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.revision_id = projects.current_revision_id)"), 0, "every project has its current revision");
});

test("RACE: a capability suspension racing CreateProject — the capability is held under a share lock to COMMIT: a suspension that comes second waits for the project; one committed first refuses it 422 CAPABILITY_UNAVAILABLE", async () => {
  // 07 "Transaction discipline" ("Preconditions are rechecked inside the relevant transaction"; "Multi-row invariants use
  // explicit locking"); catalogue CMD011 precondition "the requested mode is offered". Review findings R15/R25. SALESFORCE
  // capabilities of their own revisions, so the suspensions (terminal in this version) touch no other test's mode.
  const url = routes.createProject(w.clientA);
  const body = () => ({ mode: "SALESFORCE", purpose: "Race the suspension", targetInstanceRef: ids.next() });

  // (a) the project first: it holds at the journal commit with every lock taken; the control plane's suspension of the
  // capability it relies on is observed waiting on its share lock; the project commits on an offered capability; the
  // suspension commits after it and every later request is refused
  const first = await w.h.offeredCapability("SALESFORCE", "AVAILABLE_LIMITED", { version: "R2-RACE-SECOND" });
  const writerA = await controlWriter(w);
  try {
    const hold = w.holds.arm("journal.commit");
    const request = call(w, { url, token: w.operator.token, body: body() });
    await reachedHold(hold, request);
    const suspension = writerA.query("UPDATE kauro.capabilities SET state = 'SUSPENDED' WHERE capability_id = $1", [first]);
    try {
      await waitForWriterLockWait(w, writerA, "UPDATE kauro.capabilities");
    } finally {
      hold.release();
    }
    const created = completed<ProjectView>(await request, 201);
    assert.equal(created.data.capabilityVersion, "R2-RACE-SECOND");
    await suspension;
    await writerA.commit();
  } finally {
    await writerA.close();
  }
  assert.equal((await w.row<{ state: string }>("capabilities", "capability_id = $1", [first]))?.state, "SUSPENDED");
  assert.equal(outcome(w, await call(w, { url, token: w.operator.token, body: body() })), "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED");

  // (b) the suspension first: it holds the capability's row lock uncommitted; the project is observed waiting for its share
  // lock; the suspension commits; the project reads the committed SUSPENDED row: 422, no project, no revision, no journal row
  const second = await w.h.offeredCapability("SALESFORCE", "AVAILABLE_LIMITED", { version: "R2-RACE-FIRST" });
  const projectsBefore = await w.count("projects");
  const revisionsBefore = await w.count("dataset_revisions");
  const key = freshKey("cmd011-race-suspension-first");
  const writerB = await controlWriter(w);
  try {
    await writerB.query("UPDATE kauro.capabilities SET state = 'SUSPENDED' WHERE capability_id = $1", [second]);
    const request = call(w, { url, token: w.operator.token, key, body: body() });
    try {
      await waitForApiLockWait(w, "FROM kauro.capabilities");
    } finally {
      await writerB.commit();
    }
    assert.equal(outcome(w, await request), "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED");
  } finally {
    await writerB.close();
  }
  assert.equal(await w.count("projects"), projectsBefore);
  assert.equal(await w.count("dataset_revisions"), revisionsBefore);
  assert.equal(await w.journal(key), null);
  // the runtime role holds the capability lock and nothing else: it can change no capability column
  await assert.rejects(
    w.asTenant(w.A, (c) => c.query("UPDATE kauro.capabilities SET capability_id = capability_id WHERE capability_id = $1", [w.cleanCapabilityId])),
    (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "42501",
  );
  await assert.rejects(
    w.asTenant(w.A, (c) => c.query("UPDATE kauro.capabilities SET state = 'SUSPENDED' WHERE capability_id = $1", [w.cleanCapabilityId])),
    (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "42501",
  );
  assert.equal((await w.row<{ state: string }>("capabilities", "capability_id = $1", [w.cleanCapabilityId]))?.state, "AVAILABLE_LIMITED");
});

test("RACE: an agency transition racing CreateProject — the agency is held under a share lock to COMMIT: a closure that comes second waits for the project; one committed first refuses it 409 AGENCY_NOT_OPEN", async () => {
  // D-CMD-2 (client and project creation need a DRAFT or ACTIVE agency) rechecked under an explicit lock (07 "Transaction
  // discipline"; registry Agency edge owner_abandons_setup DRAFT -> CLOSING, effect of CLOSING "revokes new work"). Review
  // finding R15. Agencies of their own, because a CLOSING agency does not come back; their owners create the projects (OWNER
  // satisfies AGENCY_OPERATOR, D-AUTHZ-1).
  const agencyWithClient = async (name: string) => {
    const owner = await w.person(name);
    const agency = await w.h.createAgency(owner.userId, `${name} agency`);
    const clientId = await w.h.endClient(agency, await w.h.processingAuthority(agency), `${name} client`);
    return { owner, agency, clientId };
  };
  const close = async (writer: HeldTransaction, agency: AgencyFixture): Promise<void> => {
    await writer.query("UPDATE kauro.agencies SET state = 'CLOSING', version = version + 1 WHERE agency_id = $1", [agency.agencyId]);
    await rawEvent(writer.client, { aggregateKind: "agency", aggregateId: agency.agencyId, aggregateVersion: 2, agencyId: agency.agencyId, eventType: "agency.closing.v1", actorUserId: agency.ownerUserId, payload: { agencyId: agency.agencyId } });
  };
  const body = { mode: "CLEAN", purpose: "Race the closure" };

  // (a) the project first: held at the journal commit; the closure is observed waiting on the agency's share lock; the
  // project commits while the agency is still DRAFT; the closure commits after it; a later project is refused
  const c = await agencyWithClient("closing-second");
  const writerA = await tenantWriter(w, c.agency);
  try {
    const hold = w.holds.arm("journal.commit");
    const request = call(w, { url: routes.createProject(c.clientId), token: c.owner.token, agency: c.agency.agencyId, body });
    await reachedHold(hold, request);
    const closure = close(writerA, c.agency);
    try {
      await waitForWriterLockWait(w, writerA, "UPDATE kauro.agencies");
    } finally {
      hold.release();
    }
    completed<ProjectView>(await request, 201);
    await closure;
    await writerA.commit();
  } finally {
    await writerA.close();
  }
  assert.equal((await w.row<{ state: string }>("agencies", "agency_id = $1", [c.agency.agencyId]))?.state, "CLOSING");
  assert.equal(outcome(w, await call(w, { url: routes.createProject(c.clientId), token: c.owner.token, agency: c.agency.agencyId, body })), "409 PRECONDITION_FAILED AGENCY_NOT_OPEN");

  // (b) the closure first: it holds the agency row lock uncommitted; the project is observed waiting for its share lock; the
  // closure commits; the project reads CLOSING: 409 with the current state, and no project, revision or journal row exists
  const d = await agencyWithClient("closing-first");
  const key = freshKey("cmd011-race-closure-first");
  const writerB = await tenantWriter(w, d.agency);
  try {
    await close(writerB, d.agency);
    const request = call(w, { url: routes.createProject(d.clientId), token: d.owner.token, agency: d.agency.agencyId, key, body });
    try {
      await waitForApiLockWait(w, "FROM kauro.agencies");
    } finally {
      await writerB.commit();
    }
    const refused = await request;
    assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED AGENCY_NOT_OPEN");
    assert.deepEqual(asProblem(w, refused).current, { version: 2, state: "CLOSING" });
  } finally {
    await writerB.close();
  }
  assert.equal(await w.count("projects", "agency_id = $1", [d.agency.agencyId]), 0);
  assert.equal(await w.count("dataset_revisions", "agency_id = $1", [d.agency.agencyId]), 0);
  assert.equal(await w.journal(key), null);
});

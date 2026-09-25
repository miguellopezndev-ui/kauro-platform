// CMD011 CreateProject — POST /api/v1/clients/{clientId}/projects — AGENCY_OPERATOR (registry cases CMD011-OK / -DENY /
// -RACE; design §8, D-CMD-4; catalogue precondition "The client is active; the requested mode is offered and target scope is
// declared without claiming qualification"; failure "An unavailable mode returns CAPABILITY_UNAVAILABLE before quoting or
// charging"; effect "Create a project with a draft revision and visible readiness blockers"). Real route, adapters, oracle.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ArchiveClientView, EndClientView, ProjectView } from "@kauro/application";
import type { ClientId } from "@kauro/domain";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, rawEvent, rootCause, routes, sha, waitForApiLockWait, world, type World } from "./support.js";

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
  // the shortcuts — an unlisted edge DESIGN -> AVAILABLE_LIMITED (KA008) and a second HUBSPOT row for the same revision
  // (capabilities_mode_version) — so the control plane moves the existing row along the listed edges, citing each gate's
  // evidence. Implemented and internally qualified are still not offered ("Requested, implemented and qualified are different
  // states"): the mode stays refused until AVAILABLE_LIMITED.
  const control = await w.h.pg.connect("kauro_control_test");
  try {
    await assert.rejects(
      control.query("UPDATE kauro.capabilities SET state = 'AVAILABLE_LIMITED', qualification_evidence_hashes = $2::jsonb WHERE capability_id = $1", [w.hubspotCapabilityId, JSON.stringify([sha("shortcut")])]),
      (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "KA008",
    );
    await assert.rejects(
      control.query(
        `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
         VALUES ($1, 'R2-INITIAL', 'MODE', 'HUBSPOT', 'AVAILABLE_LIMITED', $2, $3::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
        [ids.next(), sha("profile-HUBSPOT"), JSON.stringify([sha("shortcut")])],
      ),
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

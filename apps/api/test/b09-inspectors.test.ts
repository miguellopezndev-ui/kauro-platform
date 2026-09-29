// The commercial inspectors of package B09 bound in the api composition (design D-INSP-B1; the re-check's residual FINAL-N3):
// CMD023 RevisePlan of an APPROVED plan checks the registry Plan edge guard "Commercial/execution consequences are reconciled"
// through CommercialConsequenceInspector, and CMD010 ArchiveClient reports the live commercial authorizations a client's projects
// retain through ActiveWorkInspector. Before B09 the edition bound a constant empty set and a zero count, so a plan on which a paid
// entitlement rests could be superseded. Real routes, the real composition (edition.ts), the pg unit of work and PostgreSQL 17; the
// paid purchase is written through the commerce adapters (@kauro/persistence/testing paidPurchase), the provider never called.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ArchiveClientView, EndClientView, ProjectView, RevisePlanView } from "@kauro/application";
import type { ClientId, FiscalIssuerRef, FiscalProfileId, PlanId, ProjectId, UserId } from "@kauro/domain";
import { activateAgency, paidPurchase, recordReviewedFiscalProfile, type QualifiedRoute } from "@kauro/persistence/testing";
import { commercialConsequencesInspector } from "../src/index.js";
import { approveThroughRoute, asProblem, call, completed, effectCounts, freshKey, outcome, routes, world, type World } from "./support.js";

let w: World;
let route: QualifiedRoute;
let issuerRef: FiscalIssuerRef;
let profileId: FiscalProfileId;

before(async () => {
  w = await world();
  // the agency sells: ACTIVE, the platform's qualified merchant and fiscal issuer routes, a reviewed fiscal profile recorded by a
  // corporate owner in its finance scope
  await activateAgency(w.h, w.A);
  route = await w.h.qualifiedPaymentRoute();
  issuerRef = await w.h.qualifiedFiscalIssuer();
  const kora = (await w.h.person("kora-corporate-owner")) as UserId;
  await w.h.grantKauroOwner(kora);
  profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: kora, agencyId: w.A.agencyId, issuerRef });
});
after(async () => {
  await w.stop();
});

async function freshClient(label: string): Promise<ClientId> {
  const created = completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), agency: null, body: { displayName: label, processingAuthorityRef: w.authorityA } }), 201);
  return created.data.clientId as ClientId;
}

/** A CLEAN project of the client created through CMD011, its plan approved through CMD025, and a purchase of it paid. */
async function paidProject(clientId: ClientId, seed: string) {
  const project = completed<ProjectView>(await call(w, { url: routes.createProject(clientId), token: w.operator.token, body: { mode: "CLEAN", purpose: seed } }), 201);
  const plan = await w.approvable(w.A, project.data.projectId as ProjectId, seed);
  await approveThroughRoute(w, plan);
  const purchase = await paidPurchase(w.h, { agency: w.A, planId: plan.planId as PlanId, route, issuerRef, profileId });
  return { projectId: project.data.projectId as ProjectId, plan, purchase };
}

test("FINAL-N3 (D-INSP-B1) CMD023 DENY: revising an APPROVED plan on which a paid purchase rests — its accepted quote and its live CommercialAuthorization, as the bound inspector names them — is 409 PRECONDITION_FAILED CONSEQUENCES_UNRECONCILED for the approval's controller and commits nothing; an approved plan of another project with no commercial fact is revised", async () => {
  const { plan, purchase } = await paidProject(w.clientA, "inspector-cmd023");

  // the route first: the paid plan is not superseded
  const body = () => ({ expectedVersion: 5, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "SCOPE_CHANGED" }) });
  const before = await effectCounts(w);
  const denied = await call(w, { url: routes.revisePlan(plan.planId), token: w.owner.token, key: freshKey("cmd023-paid"), body: body() });
  assert.equal(outcome(w, denied), "409 PRECONDITION_FAILED CONSEQUENCES_UNRECONCILED");
  // what the composition's inspector reads in the command's own unit of work, under the tenant's policies
  const named = await w.h.app.run(w.h.tenant(w.A.agencyId, w.A.ownerUserId), (uow) => commercialConsequencesInspector.unreconciledForPlan(uow, plan.planId as PlanId));
  assert.deepEqual(
    named.map((c) => [c.kind, c.referenceId]),
    [
      ["COMMERCIAL_AUTHORIZATION", purchase.authorizationId],
      ["QUOTE", purchase.quoteId],
    ],
  );
  assert.deepEqual(asProblem(w, denied).current, { version: 5, state: "APPROVED" });
  // nothing committed: no plan, approval, event, outbox or journal row (the refusal's durable fact aside)
  assert.deepEqual({ ...(await effectCounts(w)), security_events: 0 }, { ...before, security_events: 0 });
  assert.equal((await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [plan.planId]))?.state, "APPROVED");
  assert.equal((await w.row<{ state: string }>("commercial_authorizations", "authorization_id = $1", [purchase.authorizationId]))?.state, "ACTIVE");
  assert.equal(await w.count("approvals", "plan_id = $1 AND withdrawn_at IS NULL", [plan.planId]), 1);

  // the guard is the plan's own: an approved plan of another project, on which nothing commercial rests, is revised by its controller
  const other = await w.project(w.A, w.clientA);
  const unsold = await w.approvable(w.A, other.projectId, "inspector-cmd023-unsold");
  await approveThroughRoute(w, unsold);
  const revised = completed<RevisePlanView>(await call(w, { url: routes.revisePlan(unsold.planId), token: w.owner.token, key: freshKey("cmd023-unsold"), body: body() }), 201);
  assert.deepEqual(revised.data.supersededPlan, { planId: unsold.planId, version: 6, state: "SUPERSEDED" });
});

test("FINAL-N3 (D-INSP-B1) CMD010: archiving a client whose project holds a paid, live CommercialAuthorization reports it in retainedActiveWork.liveCommercialAuthorizations and revokes, refunds and deletes nothing — the authorization stays ACTIVE and its capture COMPLETED", async () => {
  const clientId = await freshClient("Archive Paid");
  const { purchase } = await paidProject(clientId, "inspector-cmd010");
  const archived = completed<ArchiveClientView>(await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, key: freshKey("cmd010-paid"), body: { expectedVersion: 1 } }), 200);
  assert.equal(archived.data.client.state, "ARCHIVED");
  assert.deepEqual(archived.data.retainedActiveWork, { openProjects: 1, activeJobs: 0, liveCommercialAuthorizations: 1 });
  assert.equal((await w.row<{ state: string }>("commercial_authorizations", "authorization_id = $1", [purchase.authorizationId]))?.state, "ACTIVE");
  assert.equal((await w.row<{ status: string }>("capture_facts", "capture_id = $1", [purchase.captureId]))?.status, "COMPLETED");
  assert.equal(await w.count("refunds", "capture_id = $1", [purchase.captureId]), 0, "archiving is never an implicit refund");
  // another client's archive counts only its own projects' authorizations
  const bare = await freshClient("Archive Bare");
  const bareArchived = completed<ArchiveClientView>(await call(w, { url: routes.archiveClient(bare), token: w.admin.token, key: freshKey("cmd010-bare"), body: { expectedVersion: 1 } }), 200);
  assert.deepEqual(bareArchived.data.retainedActiveWork, { openProjects: 0, activeJobs: 0, liveCommercialAuthorizations: 0 });
});

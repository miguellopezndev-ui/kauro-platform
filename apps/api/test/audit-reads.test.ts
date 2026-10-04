// GetAudit through its route (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §6, §12 D8-API-1;
// docs/design/B08-case-map.md GetAudit): every live member of the agency reads an audit's durable phase, its deadlines, the classification of
// its grant and the decisions still needed — and nothing of the provider, the prompt, the profile's evidence, the steps or the pool the grant was
// carved from. The audit is moved through its life by the control plane's steps written through the product's adapters (audit-support.ts); the
// reads are the real GET route.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import {
  AUDIT_POLICY,
  auditRow,
  auditWorld,
  cancelAudit,
  draftReady,
  driveTo,
  endLiveAudits,
  forbiddenTokensOf,
  fundPool,
  getAudit,
  grantRow,
  needsDecision,
  plannedModelTask,
  secondsBetween,
  startedAudit,
  unsupported,
  viewOf,
  auditRoutes,
  type AuditView,
  type AuditWorld,
  type StartedAudit,
} from "./audit-support.js";
import { asProblem, call, completed, outcome } from "./support.js";

let aw: AuditWorld;
before(async () => {
  aw = await auditWorld();
  await fundPool(aw);
});
after(async () => {
  await aw.stop();
});
afterEach(async () => {
  await endLiveAudits(aw.w);
});

/** Every member the AuditView may carry (design §12): the rest of the registry Audit contract is withheld with a reason. */
const AUDIT_VIEW_MEMBERS: ReadonlyArray<string> = [
  "auditId",
  "revisionId",
  "targetContractId",
  "state",
  "version",
  "startedAt",
  "interpretationDeadlineAt",
  "absoluteDeadline",
  "grantId",
  "grantClass",
  "grantState",
  "candidateManifestHash",
  "cancelVersion",
  "pendingDecisions",
  "unsupportedCapabilities",
  "terminalReason",
  "draftPlanId",
  "permittedActions",
];

interface Expected {
  readonly state: string;
  readonly version: number;
  readonly cancelVersion?: number;
}

/** Reads the audit as a member and checks it against the row the steps left: what the customer sees is the row's safe part. */
async function seen(started: StartedAudit, expected: Expected, token: string = aw.w.viewer.token): Promise<{ readonly view: AuditView; readonly text: string }> {
  const { w } = aw;
  const row = await auditRow(w, started.auditId);
  const reply = await getAudit(w, started.auditId, token);
  const view = viewOf(reply);
  assert.equal(row.state, expected.state, "the row is where the step left it");
  assert.deepEqual([view.auditId, view.revisionId, view.targetContractId, view.grantId], [row.audit_id, row.revision_id, row.target_contract_id, row.grant_id]);
  assert.deepEqual([view.state, view.version, view.cancelVersion], [expected.state, expected.version, expected.cancelVersion ?? 0]);
  assert.equal(Number(row.version), expected.version);
  // the deadlines the row stamped: the audit's start and its absolute deadline a day later (D8-DL-1); the interpretation deadline only once INTERPRETING began
  assert.equal(Date.parse(view.startedAt), row.started_at.getTime());
  assert.equal(Date.parse(view.absoluteDeadline), row.absolute_deadline_at.getTime());
  assert.equal(secondsBetween(view.startedAt, view.absoluteDeadline), AUDIT_POLICY.auditAbsoluteSeconds);
  assert.equal(view.interpretationDeadlineAt === undefined ? null : Date.parse(view.interpretationDeadlineAt), row.interpretation_deadline_at === null ? null : row.interpretation_deadline_at.getTime());
  // the grant's classification: a free audit carved from the platform's pool; the view says what it is, never which pool
  const grant = await grantRow(w, row.grant_id);
  assert.deepEqual([view.grantClass, view.grantState], ["FREE_AUDIT", grant.state]);
  assert.equal(view.candidateManifestHash, row.candidate_manifest_hash ?? undefined);
  assert.equal(view.terminalReason, row.terminal_reason ?? undefined);
  assert.equal(view.draftPlanId, row.draft_plan_id ?? undefined);
  // never a provider identity, a prompt, evidence or the fence: no member outside the view, no token of the row's private part in the text
  assert.deepEqual(Object.keys(view).filter((k) => !AUDIT_VIEW_MEMBERS.includes(k)), [], "only the view's members");
  for (const forbidden of await forbiddenTokensOf(w, started.auditId)) assert.equal(reply.text.includes(forbidden), false, `the view leaks ${forbidden}`);
  return { view, text: reply.text };
}

/** The actions each kind of member is offered on the audit at this state (informative, never authority). */
async function offered(started: StartedAudit, expected: Expected, operating: ReadonlyArray<string>): Promise<void> {
  const { w } = aw;
  for (const person of [w.owner, w.admin, w.operator]) assert.deepEqual((await seen(started, expected, person.token)).view.permittedActions, operating, "an operating role");
  for (const person of [w.approver, w.approver2, w.billing, w.viewer]) assert.deepEqual((await seen(started, expected, person.token)).view.permittedActions, [], "a reading role");
}

async function restart(): Promise<StartedAudit> {
  await endLiveAudits(aw.w);
  return startedAudit(aw);
}

test("GetAudit answers the durable phase, deadlines, grant classification and pending decisions to live members only, never a provider identity, a prompt or a customer value", async () => {
  const { w } = aw;

  // QUEUED (v1): the deadlines of the start, no interpretation deadline, no candidate manifest, nothing decided — an operating role may cancel
  const queued = await startedAudit(aw);
  const { view: first } = await seen(queued, { state: "QUEUED", version: 1 });
  assert.equal(first.grantState, "AUTHORIZED");
  assert.deepEqual([first.interpretationDeadlineAt, first.candidateManifestHash, first.pendingDecisions, first.unsupportedCapabilities, first.terminalReason, first.draftPlanId], [undefined, undefined, undefined, undefined, undefined, undefined]);
  await offered(queued, { state: "QUEUED", version: 1 }, ["CancelAudit"]);

  // PROFILING (v2): the profile worker claimed the audit
  await driveTo(w, queued, "PROFILING");
  const profiling = await seen(queued, { state: "PROFILING", version: 2 });
  assert.equal(profiling.view.candidateManifestHash, undefined);
  await offered(queued, { state: "PROFILING", version: 2 }, ["CancelAudit"]);

  // INTERPRETING (v3): the candidate manifest planned and the interpretation deadline stamped a fixed span after the phase began; a model task is
  // planned, and its provider identity is nowhere in the view
  const interpreting = await restart();
  const at = { agencyId: w.A.agencyId, auditId: interpreting.auditId };
  await needsDecision(w, at, ["MERGE_POLICY_UNRESOLVED", "ENUM_VALUE_UNMAPPED"], async () => {
    // the audit is INTERPRETING here (v3): read it, with its model task planned
    await plannedModelTask(w, at);
    const reading = await seen(interpreting, { state: "INTERPRETING", version: 3 });
    assert.equal(typeof reading.view.candidateManifestHash, "string");
    assert.equal(typeof reading.view.interpretationDeadlineAt, "string");
    const stamped = await w.h.oracle.query<{ interpreting_at: Date }>("SELECT interpreting_at FROM kauro.audits WHERE audit_id = $1", [interpreting.auditId]);
    assert.equal(secondsBetween((stamped.rows[0] as { interpreting_at: Date }).interpreting_at.toISOString(), reading.view.interpretationDeadlineAt as string), AUDIT_POLICY.interpretationSeconds);
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.model_tasks WHERE audit_id = $1", [interpreting.auditId])).rowCount, 1, "the model task exists and stays private");
    assert.equal(reading.view.pendingDecisions, undefined);
    await offered(interpreting, { state: "INTERPRETING", version: 3 }, ["CancelAudit"]);
  });

  // NEEDS_DECISION (v4): what only the agency can decide, in the order the interpretation named it; CreatePlan is offered, a cancellation is not
  const deciding = await seen(interpreting, { state: "NEEDS_DECISION", version: 4 });
  assert.deepEqual(deciding.view.pendingDecisions, ["MERGE_POLICY_UNRESOLVED", "ENUM_VALUE_UNMAPPED"]);
  assert.equal(deciding.view.unsupportedCapabilities, undefined);
  assert.equal(typeof deciding.view.candidateManifestHash, "string");
  await offered(interpreting, { state: "NEEDS_DECISION", version: 4 }, ["CreatePlan"]);

  // UNSUPPORTED (v4): the capabilities the mode does not offer, named; nothing to decide or cancel
  const notOffered = await restart();
  await unsupported(w, { agencyId: w.A.agencyId, auditId: notOffered.auditId }, ["CAPABILITY_NOT_OFFERED", "MODE_NOT_OFFERED"]);
  const limited = await seen(notOffered, { state: "UNSUPPORTED", version: 4 });
  assert.deepEqual(limited.view.unsupportedCapabilities, ["CAPABILITY_NOT_OFFERED", "MODE_NOT_OFFERED"]);
  assert.equal(limited.view.pendingDecisions, undefined);
  await offered(notOffered, { state: "UNSUPPORTED", version: 4 }, []);

  // FAILED (v3): the reason the orchestration ended it with, no draft
  const broken = await restart();
  await driveTo(w, broken, "FAILED");
  const failing = await seen(broken, { state: "FAILED", version: 3 });
  assert.equal(failing.view.terminalReason, "PROFILE_FAILED");
  assert.equal(failing.view.draftPlanId, undefined);
  await offered(broken, { state: "FAILED", version: 3 }, []);

  // CANCELLED (v2): the agency's own cancellation through the route; its version and its reason
  const abandoned = await restart();
  completed<AuditView>(await cancelAudit(w, abandoned.auditId, { expectedVersion: 1 }), 200);
  const cancelled = await seen(abandoned, { state: "CANCELLED", version: 2, cancelVersion: 1 });
  assert.equal(cancelled.view.terminalReason, "AGENCY_CANCELLED");
  await offered(abandoned, { state: "CANCELLED", version: 2, cancelVersion: 1 }, []);

  // DRAFT_READY (v5): the system draft's plan id, and only that — no plan body, hash or receipt
  const drafted = await restart();
  const { draftPlanId } = await draftReady(w, { agencyId: w.A.agencyId, auditId: drafted.auditId }, drafted.subject);
  const ready = await seen(drafted, { state: "DRAFT_READY", version: 5 });
  assert.equal(ready.view.draftPlanId, draftPlanId);
  assert.equal(ready.text.includes(drafted.subject.revisionHash), false);
  await offered(drafted, { state: "DRAFT_READY", version: 5 }, []);

  // the audit of another agency is not this agency's to read: 404, the answer of an audit that never existed; a stranger to the agency is no member
  const unknown = "0190c7a2-0000-7000-8000-0000000000cc";
  const foreign = await getAudit(w, drafted.auditId, w.stranger.token, w.B.agencyId);
  const missing = await getAudit(w, unknown, w.stranger.token, w.B.agencyId);
  assert.equal(outcome(w, foreign), "404 NOT_FOUND -");
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, missing), correlationId: "" }, "a foreign and a nonexistent audit answer alike");
  assert.equal(outcome(w, await getAudit(w, unknown)), "404 NOT_FOUND -");
  const denied = (await w.securityEvents("GET_AUDIT")).length;
  assert.equal(outcome(w, await getAudit(w, drafted.auditId, w.stranger.token)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.deepEqual((await w.securityEvents("GET_AUDIT")).slice(denied).map((f) => [f.outcome, f.reason, f.actorId]), [["DENY", "NOT_A_MEMBER", w.stranger.userId]]);
  // only live members: a suspended member and an invitation never accepted read nothing, and an unauthenticated caller is refused
  assert.equal(outcome(w, await getAudit(w, drafted.auditId, w.suspended.token)), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(outcome(w, await getAudit(w, drafted.auditId, w.invited.token)), "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE");
  const anonymous = await call(w, { method: "GET", url: auditRoutes.getAudit(drafted.auditId), token: null, key: null, contentType: null });
  assert.equal(outcome(w, anonymous), "401 AUTHENTICATION_REQUIRED -");
});

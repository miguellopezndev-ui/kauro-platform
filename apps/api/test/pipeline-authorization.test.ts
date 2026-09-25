// The command pipeline and its authorization boundary, through the real routes, the real composition root and a real
// PostgreSQL 17 (review record docs/design/B06-review/A-pipeline-authorization.md, findings R1/R8, R2, R7/R12, R9, R16, R18,
// R26). One order holds for every tenant-scoped command (10 "Request envelope": authenticated subject, then authorization,
// then application execution; 10 "Idempotency contract"; 08 "Browser, API and cache isolation": foreign and nonexistent
// resources produce equivalent safe visibility, errors do not disclose that an agency exists; D-AUTHZ-4):
//   1–7  subject, identity status (token facts and the stored identity row), live membership (read after its transition lock, held to the end of the
//        unit of work), ACTIVE, role — before anything tenant-scoped is written or probed;
//        the journal reservation — a replay, a conflict or a pending entry is answered only to a caller authorized here;
//   8    the step-up a new execution needs (a replay performs no effect and needs none);
//   9–10 the handler's resource relationship (CMD026: the approval controller) before version and state.
// Denials are durable facts of the right stream: an agency's stream only for a caller whose live membership in it the
// recording transaction proves, the caller's own identity stream otherwise (naming the agency the request selected), and an
// anonymous fact for a request without an authenticated subject (08 "Audit events and retention", "Threat model").
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PoolClient } from "pg";
import type { AgencyView, ApprovePlanView, EndClientView, MembershipView, WithdrawApprovalView } from "@kauro/application";
import type { Clock, ProjectId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { waitForLockWait } from "@kauro/persistence/testing";
import {
  approvalBodyOf,
  approveThroughRoute,
  call,
  completed,
  effectCounts,
  freshKey,
  ids,
  outcome,
  rawEvent,
  replayTextOf,
  routes,
  waitForApiLockWait,
  world,
  type Reply,
  type World,
} from "./support.js";

/** The api's clock: real time plus an offset a test moves forward, so a step-up proof ages without anyone sleeping. */
let offsetMs = 0;
const apiClock: Clock = { now: () => toUtcInstant(Date.now() + offsetMs), nowMs: () => Date.now() + offsetMs };

/** application_name of the harness's runtime pool (the owner's direct membership writes run there). */
const HARNESS_APP_POOL = "kauro-test-api";

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world({ clock: apiClock });
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

interface Fact {
  readonly actor_kind: string;
  readonly actor_id: string | null;
  readonly agency_id: string | null;
  readonly requested_agency_id: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly assurance_class: string;
  readonly policy_version: string;
}

/** Superuser oracle: the security facts matching a predicate, in append order. */
async function facts(where: string, params: ReadonlyArray<unknown>): Promise<ReadonlyArray<Fact>> {
  const r = await w.h.oracle.query<Fact>(
    `SELECT actor_kind, actor_id, agency_id, requested_agency_id, action, outcome, reason_code, assurance_class, policy_version
       FROM kauro.security_events WHERE ${where} ORDER BY occurred_at, security_event_id`,
    [...params],
  );
  return r.rows.map((x) => ({ ...x }));
}

function correlationOf(reply: Reply): string {
  const value = reply.headers["x-correlation-id"];
  if (typeof value !== "string") throw new Error(`the reply carries no correlation id: ${reply.text}`);
  return value;
}

function fact(over: Partial<Fact> & Pick<Fact, "action" | "outcome" | "reason_code">): Fact {
  return { actor_kind: "USER", actor_id: null, agency_id: null, requested_agency_id: null, assurance_class: "SESSION", policy_version: "B06-1", ...over };
}

/** A transaction of the runtime role under the owner of agency A's tenant context (the owner's own membership writes). */
async function ownerTransaction(): Promise<PoolClient> {
  const c = await w.h.appPool.raw.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [w.A.agencyId, w.owner.userId]);
    return c;
  } catch (e) {
    c.release();
    throw e;
  }
}

interface MembershipChange {
  readonly state?: "ACTIVE" | "SUSPENDED" | "REVOKED";
  readonly role?: { readonly from: string; readonly to: string };
}

/** A listed Membership edge (or a role change) with its version bump and event, written by the owner inside `c`. */
async function moveMembership(c: PoolClient, membershipId: string, change: MembershipChange): Promise<void> {
  const r = await c.query<{ version: string }>(
    `UPDATE kauro.memberships
        SET state = coalesce($2::text, state), role = coalesce($3::text, role),
            revoked_at = CASE WHEN $2::text = 'REVOKED' THEN now() ELSE revoked_at END, version = version + 1
      WHERE membership_id = $1 RETURNING version`,
    [membershipId, change.state ?? null, change.role?.to ?? null],
  );
  const version = Number(r.rows[0]?.version);
  const base = { membershipId, agencyId: w.A.agencyId, byMembershipId: w.A.ownerMembershipId };
  const [eventType, payload]: [string, Record<string, string>] =
    change.role !== undefined
      ? ["membership.role_changed.v1", { ...base, role: change.role.to, previousRole: change.role.from }]
      : change.state === "REVOKED"
        ? ["membership.revoked.v1", { ...base, reasonCode: "REVIEW_PROBE" }]
        : change.state === "SUSPENDED"
          ? ["membership.suspended.v1", base]
          : ["membership.reactivated.v1", base];
  await rawEvent(c, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: version, agencyId: w.A.agencyId, eventType, actorUserId: w.owner.userId, payload });
}

/** Commits one membership change as the owner, sequentially (not a race). */
async function changeMembership(membershipId: string, change: MembershipChange): Promise<void> {
  const c = await ownerTransaction();
  try {
    await moveMembership(c, membershipId, change);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

test("R1/R8 DENY: a nonexistent agency and an existing foreign agency answer byte-equal problems on a path-scoped and on a header-scoped route; no journal row, no effect, nothing in any agency's stream", async () => {
  const nonexistent = ids.next();
  const correlation = ids.next();
  const headers = { "x-correlation-id": correlation };
  const createBody = { displayName: "Existence probe", processingAuthorityRef: w.authorityA };
  const keys = { pathForeign: freshKey("r1-path-foreign"), pathMissing: freshKey("r1-path-missing"), headerForeign: freshKey("r1-header-foreign"), headerMissing: freshKey("r1-header-missing") };
  const before = await effectCounts(w);

  // the stranger owns agency B only: A exists and is foreign to them, `nonexistent` names no agency at all
  const pathForeign = await call(w, { url: routes.createClient(w.A.agencyId), token: w.stranger.token, agency: null, key: keys.pathForeign, headers, body: createBody });
  const pathMissing = await call(w, { url: routes.createClient(nonexistent), token: w.stranger.token, agency: null, key: keys.pathMissing, headers, body: createBody });
  const headerForeign = await call(w, { url: routes.archiveClient(w.clientA), token: w.stranger.token, agency: w.A.agencyId, key: keys.headerForeign, headers, body: { expectedVersion: 1 } });
  const headerMissing = await call(w, { url: routes.archiveClient(w.clientA), token: w.stranger.token, agency: nonexistent, key: keys.headerMissing, headers, body: { expectedVersion: 1 } });

  assert.equal(outcome(w, pathForeign), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, headerForeign), "404 NOT_FOUND NOT_A_MEMBER");
  for (const [foreign, missing, route] of [[pathForeign, pathMissing, "path"], [headerForeign, headerMissing, "header"]] as const) {
    assert.equal(missing.status, foreign.status, `${route}: status`);
    assert.equal(missing.contentType, foreign.contentType, `${route}: content type`);
    assert.equal(missing.headers["x-correlation-id"], foreign.headers["x-correlation-id"], `${route}: correlation header`);
    assert.equal(missing.text, foreign.text, `${route}: the problem bytes of a nonexistent agency equal those of a foreign one`);
  }

  // nothing tenant-scoped was written or probed before membership was proven: no journal row, no row in any effect table
  // (the durable denial facts aside), and no fact in any agency's stream — neither A's nor the stranger's own B
  for (const key of Object.values(keys)) assert.equal(await w.journal(key), null, `no journal row for ${key}`);
  const after = await effectCounts(w);
  assert.deepEqual({ ...after, security_events: 0 }, { ...before, security_events: 0 });
  assert.deepEqual(await facts("correlation_id = $1 AND agency_id IS NOT NULL", [correlation]), []);
});

test("R2 DENY: an unverified or disabled outsider writes nothing into another agency's security stream; its denial is a fact of its own identity stream naming the agency it selected; an unverified member's denial stays in its agency's stream", async () => {
  const outsiders = [w.unverified, await w.person("r2-disabled-outsider", { state: "DISABLED" })];
  const inB = await w.count("security_events", "agency_id = $1", [w.B.agencyId]);
  const unverified = await call(w, { url: routes.createClient(w.B.agencyId), token: w.unverified.token, agency: null, body: { displayName: "Outsider", processingAuthorityRef: w.authorityB } });
  assert.equal(outcome(w, unverified), "403 NOT_AUTHORIZED IDENTITY_UNVERIFIED");
  const disabled = await call(w, { url: routes.archiveClient(w.clientB), token: outsiders[1]!.token, agency: w.B.agencyId, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, disabled), "403 NOT_AUTHORIZED IDENTITY_DISABLED");

  // B's stream is unchanged, and B's runtime role reads no fact of either outsider
  assert.equal(await w.count("security_events", "agency_id = $1", [w.B.agencyId]), inB);
  const visibleToB = await w.asTenant(w.B, async (c) => (await c.query("SELECT actor_id FROM kauro.security_events WHERE actor_id = ANY($1::text[])", [outsiders.map((p) => p.userId)])).rows);
  assert.deepEqual(visibleToB, []);
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(unverified)]), [fact({ actor_id: w.unverified.userId, requested_agency_id: w.B.agencyId, action: "CMD009", outcome: "DENY", reason_code: "IDENTITY_UNVERIFIED" })]);
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(disabled)]), [fact({ actor_id: outsiders[1]!.userId, requested_agency_id: w.B.agencyId, action: "CMD010", outcome: "DENY", reason_code: "IDENTITY_DISABLED" })]);

  // positive control: an unverified person who does hold a live membership of A is denied the same way, and that fact
  // belongs to A's stream
  const lapsed = await w.person("r2-unverified-member", { verified: false });
  await w.h.addMember(w.A, lapsed.userId, "OPERATOR");
  const member = await call(w, { url: routes.createClient(w.A.agencyId), token: lapsed.token, agency: null, body: { displayName: "Member", processingAuthorityRef: w.authorityA } });
  assert.equal(outcome(w, member), "403 NOT_AUTHORIZED IDENTITY_UNVERIFIED");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(member)]), [fact({ actor_id: lapsed.userId, agency_id: w.A.agencyId, action: "CMD009", outcome: "DENY", reason_code: "IDENTITY_UNVERIFIED" })]);
});

test("R7/R12 DENY: an idempotent replay is answered only to a caller who is still authorized — suspended 403, revoked 404, each recorded; a conflicting body gets the same refusal; reactivated, the replay is the original answer byte for byte", async () => {
  const p = await w.person("r7-operator");
  const membershipId = await w.h.addMember(w.A, p.userId, "OPERATOR");
  const key = freshKey("r7-replay");
  const body = { displayName: "R7 replay client", processingAuthorityRef: w.authorityA };
  const request = { url: routes.createClient(w.A.agencyId), token: p.token, agency: null, key, body };
  const first = await call(w, request);
  completed<EndClientView>(first, 201);

  await changeMembership(membershipId, { state: "SUSPENDED" });
  const suspended = await call(w, request);
  assert.equal(outcome(w, suspended), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(suspended)]), [fact({ actor_id: p.userId, agency_id: w.A.agencyId, action: "CMD009", outcome: "DENY", reason_code: "MEMBERSHIP_SUSPENDED" })]);
  const conflicting = await call(w, { ...request, body: { ...body, displayName: "R7 another label" } });
  assert.equal(outcome(w, conflicting), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED", "authorization answers before the idempotency conflict");

  await changeMembership(membershipId, { state: "ACTIVE" });
  const replay = await call(w, request);
  assert.equal(replay.status, 201);
  assert.equal(replay.text, replayTextOf(first), "the authorized replay is the journaled answer");

  await changeMembership(membershipId, { state: "REVOKED" });
  const revoked = await call(w, request);
  assert.equal(outcome(w, revoked), "404 NOT_FOUND NOT_A_MEMBER");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(revoked)]), [fact({ actor_id: p.userId, requested_agency_id: w.A.agencyId, action: "CMD009", outcome: "DENY", reason_code: "NOT_A_MEMBER" })]);

  assert.equal(await w.count("end_clients", "display_name = $1", [body.displayName]), 1);
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [key]), 1);
});

test("R7 control (recovery kept): a CMD025 replay needs the approver's current membership and role, not a fresh step-up — after the proof aged past the freshness window the replay still returns the journaled approval, while a new approval with that proof is ASSURANCE_REQUIRED", async () => {
  const plan = await w.approvable(w.A, projectId, "r7-step-up");
  const proof = await w.stepUp(w.approver);
  const request = { url: routes.approvePlan(plan.planId), token: w.approver.token, key: freshKey("r7-step-up"), body: approvalBodyOf(plan, proof) };
  const first = await call(w, request);
  completed<ApprovePlanView>(first, 201);
  offsetMs = 16 * 60_000;
  try {
    const replay = await call(w, request);
    assert.equal(replay.status, 201);
    assert.equal(replay.text, replayTextOf(first));
    const other = await w.approvable(w.A, projectId, "r7-step-up-other");
    const stale = await call(w, { url: routes.approvePlan(other.planId), token: w.approver.token, body: approvalBodyOf(other, proof) });
    assert.equal(outcome(w, stale), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  } finally {
    offsetMs = 0;
  }
});

test("R9 RACE: a command in flight holds its actor's membership — a revocation issued meanwhile waits until the approval commits; a revocation, suspension or role change committed first makes the command wait on the membership and then refuses it", async () => {
  // --- command first: the approval holds at the collaborator point with its transaction open; the owner's revocation of the
  // approver is observed waiting on the membership row; the approval commits, then the revocation does
  const first = await w.person("r9-approver-first");
  const firstMembership = await w.h.addMember(w.A, first.userId, "APPROVER");
  const planOne = await w.approvable(w.A, projectId, "r9-first");
  const proofOne = await w.stepUp(first);
  const hold = w.holds.arm("collaborator");
  const approval = call(w, { url: routes.approvePlan(planOne.planId), token: first.token, key: freshKey("r9-first"), body: approvalBodyOf(planOne, proofOne) });
  await hold.reached;
  const revoker = await ownerTransaction();
  const revocation = moveMembership(revoker, firstMembership, { state: "REVOKED" })
    .then(() => revoker.query("COMMIT"))
    .then(
      () => null,
      async (e: unknown) => {
        await revoker.query("ROLLBACK");
        return e;
      },
    )
    .finally(() => revoker.release());
  try {
    await waitForLockWait(w.h.oracle, HARNESS_APP_POOL, "UPDATE kauro.memberships");
  } finally {
    hold.release();
  }
  const approved = completed<ApprovePlanView>(await approval, 201);
  assert.equal(await revocation, null, "the revocation commits once the approval has");
  // the member was invited (v1) and accepted (v2) along the Membership edges; the approval records the version it acted
  // under, and the revocation, ordered after it, is the next version
  const approvalRow = await w.row<{ actor_membership_id: string; actor_membership_version: string }>("approvals", "approval_id = $1", [approved.data.approval.approvalId]);
  assert.deepEqual(approvalRow && { membership: approvalRow.actor_membership_id, version: approvalRow.actor_membership_version }, { membership: firstMembership, version: "2" });
  const membershipRow = await w.row<{ state: string; version: string }>("memberships", "membership_id = $1", [firstMembership]);
  assert.deepEqual(membershipRow && { state: membershipRow.state, version: membershipRow.version }, { state: "REVOKED", version: "3" });
  const afterRevocation = await w.approvable(w.A, projectId, "r9-first-after");
  assert.equal(outcome(w, await call(w, { url: routes.approvePlan(afterRevocation.planId), token: first.token, body: approvalBodyOf(afterRevocation, await w.stepUp(first)) })), "404 NOT_FOUND NOT_A_MEMBER");

  // --- change first: the owner's change is written and not yet committed; the command is observed waiting on the
  // membership row; the change commits and the command answers from the committed membership
  const cases: ReadonlyArray<{ readonly name: string; readonly role: "APPROVER" | "OPERATOR"; readonly change: MembershipChange; readonly expected: string }> = [
    { name: "r9-revoked-first", role: "APPROVER", change: { state: "REVOKED" }, expected: "404 NOT_FOUND NOT_A_MEMBER" },
    { name: "r9-suspended-first", role: "OPERATOR", change: { state: "SUSPENDED" }, expected: "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED" },
    { name: "r9-demoted-first", role: "OPERATOR", change: { role: { from: "OPERATOR", to: "VIEWER" } }, expected: "403 NOT_AUTHORIZED ROLE_INSUFFICIENT" },
  ];
  for (const c of cases) {
    const person = await w.person(c.name);
    const membershipId = await w.h.addMember(w.A, person.userId, c.role);
    const plan = c.role === "APPROVER" ? await w.approvable(w.A, projectId, c.name) : null;
    const proof = c.role === "APPROVER" ? await w.stepUp(person) : null;
    const before = await effectCounts(w);
    const changer = await ownerTransaction();
    let request: Promise<Reply> | null = null;
    try {
      await moveMembership(changer, membershipId, c.change);
      request =
        plan !== null && proof !== null
          ? call(w, { url: routes.approvePlan(plan.planId), token: person.token, key: freshKey(c.name), body: approvalBodyOf(plan, proof) })
          : call(w, { url: routes.createClient(w.A.agencyId), token: person.token, agency: null, key: freshKey(c.name), body: { displayName: c.name, processingAuthorityRef: w.authorityA } });
      await waitForApiLockWait(w, "await_transition('kauro.memberships'");
      await changer.query("COMMIT");
    } catch (e) {
      await changer.query("ROLLBACK");
      throw e;
    } finally {
      changer.release();
    }
    const reply = await request;
    assert.equal(outcome(w, reply), c.expected, c.name);
    const after = await effectCounts(w);
    // the change itself wrote one membership event; the refused command wrote only its denial fact
    assert.deepEqual({ ...after, security_events: 0, domain_events: 0 }, { ...before, security_events: 0, domain_events: 0 }, c.name);
    assert.equal(after.domain_events - before.domain_events, 1, c.name);
    assert.equal(after.security_events - before.security_events, 1, c.name);
  }
});

test("R16 DENY: the authorizer consults the stored identity state — a member whose identity row is DISABLED is refused IDENTITY_DISABLED although the token says ACTIVE, CreateAgency likewise, and nothing re-enables the row; enabled again, the member is admitted", async () => {
  const member = await w.person("r16-member");
  await w.h.addMember(w.A, member.userId, "OPERATOR");
  await w.h.oracle.query("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [member.userId]);
  const body = { displayName: "R16 client", processingAuthorityRef: w.authorityA };
  const refused = await call(w, { url: routes.createClient(w.A.agencyId), token: member.token, agency: null, body });
  assert.equal(outcome(w, refused), "403 NOT_AUTHORIZED IDENTITY_DISABLED");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(refused)]), [fact({ actor_id: member.userId, agency_id: w.A.agencyId, action: "CMD009", outcome: "DENY", reason_code: "IDENTITY_DISABLED" })]);

  const founder = await w.person("r16-founder");
  await w.h.oracle.query("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [founder.userId]);
  const agency = await call(w, { url: routes.createAgency(), token: founder.token, agency: null, body: { displayName: "Disabled Founder Agency" } });
  assert.equal(outcome(w, agency), "403 NOT_AUTHORIZED IDENTITY_DISABLED");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(agency)]), [fact({ actor_id: founder.userId, action: "CMD001", outcome: "DENY", reason_code: "IDENTITY_DISABLED" })]);
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [founder.userId]), 0);
  assert.equal((await w.row<{ state: string }>("identities", "user_id = $1", [founder.userId]))?.state, "DISABLED", "the token's facts never overwrite a stored DISABLED");

  await w.h.oracle.query("UPDATE kauro.identities SET state = 'ACTIVE' WHERE user_id = $1", [member.userId]);
  completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), token: member.token, agency: null, body }), 201);
});

test("R26: an unauthenticated command, a non-member probe and an identity-status denial each leave one durable DENY fact of the right shape; CMD001 records the owner grant and CMD025 the step-up as ALLOW facts in the agency's stream, and a replay records nothing", async () => {
  // no subject at all, no selector: an anonymous fact that belongs to no stream
  const anonymous = await call(w, { url: routes.createAgency(), token: null, agency: null, body: { displayName: "No subject" } });
  assert.equal(outcome(w, anonymous), "401 AUTHENTICATION_REQUIRED -");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(anonymous)]), [fact({ actor_kind: "ANONYMOUS", action: "CMD001", outcome: "DENY", reason_code: "SUBJECT_UNAUTHENTICATED", assurance_class: "NONE" })]);
  // an unknown bearer token on a path-scoped route: still anonymous, and the fact names the selector the request carried
  const unknown = await call(w, { url: routes.createClient(w.A.agencyId), token: "unknown-token-0123456789", agency: null, body: { displayName: "No subject", processingAuthorityRef: w.authorityA } });
  assert.equal(outcome(w, unknown), "401 AUTHENTICATION_REQUIRED -");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(unknown)]), [fact({ actor_kind: "ANONYMOUS", requested_agency_id: w.A.agencyId, action: "CMD009", outcome: "DENY", reason_code: "SUBJECT_UNAUTHENTICATED", assurance_class: "NONE" })]);
  // one agency trying to reach another: the non-member's probe is a fact of the prober's identity stream naming the target
  const probe = await call(w, { url: routes.archiveClient(w.clientA), token: w.stranger.token, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, probe), "404 NOT_FOUND NOT_A_MEMBER");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(probe)]), [fact({ actor_id: w.stranger.userId, requested_agency_id: w.A.agencyId, action: "CMD010", outcome: "DENY", reason_code: "NOT_A_MEMBER" })]);

  // CMD001: the ownership the command creates is an ALLOW fact of the new agency's stream, committed with it
  const founder = await w.person("r26-founder");
  const createAgency = { url: routes.createAgency(), token: founder.token, agency: null, key: freshKey("r26-agency"), body: { displayName: "Founder Agency" } };
  const created = await call(w, createAgency);
  const agency = completed<{ agency: AgencyView; membership: MembershipView }>(created, 201).data.agency;
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(created)]), [fact({ actor_id: founder.userId, agency_id: agency.agencyId, action: "CMD001", outcome: "ALLOW", reason_code: "OWNERSHIP_GRANTED" })]);
  const agencyReplay = await call(w, createAgency);
  assert.equal(agencyReplay.status, 201);
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(agencyReplay)]), [], "a replay grants nothing and records nothing");

  // CMD025: the step-up that authorized the approval is an ALLOW fact with assurance class STEP_UP
  const plan = await w.approvable(w.A, projectId, "r26-step-up");
  const proof = await w.stepUp(w.approver);
  const approve = { url: routes.approvePlan(plan.planId), token: w.approver.token, key: freshKey("r26-approve"), body: approvalBodyOf(plan, proof) };
  const approved = await call(w, approve);
  completed<ApprovePlanView>(approved, 201);
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(approved)]), [fact({ actor_id: w.approver.userId, agency_id: w.A.agencyId, action: "CMD025", outcome: "ALLOW", reason_code: "STEP_UP_FRESH", assurance_class: "STEP_UP" })]);
  const approveReplay = await call(w, approve);
  assert.equal(approveReplay.status, 201);
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(approveReplay)]), []);
  // a command that fails after the step-up commits nothing, its ALLOW fact included
  const stale = await call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, body: approvalBodyOf(plan, await w.stepUp(w.approver)) });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(stale)]), []);
});

test("R18 DENY: CMD026 checks the approval controller before version and state — a non-controlling APPROVER is NOT_APPROVAL_CONTROLLER (recorded) with a stale version and on a WITHDRAWN plan; the controller and an OWNER get the version and state answers; a plan that never carried an approval answers its state", async () => {
  const plan = await w.approvable(w.A, projectId, "r18");
  const approved = await approveThroughRoute(w, plan, w.approver);
  assert.equal(approved.data.plan.version, 5);
  const withdraw = (who: { readonly token: string }, expectedVersion: number, planId: string = plan.planId): Promise<Reply> =>
    call(w, { url: routes.withdrawApproval(planId), token: who.token, body: { expectedVersion, reasonCode: "REVIEW_ORDER" } });

  const staleOther = await withdraw(w.approver2, 4);
  assert.equal(outcome(w, staleOther), "403 NOT_AUTHORIZED NOT_APPROVAL_CONTROLLER", "the controller check precedes the version check");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(staleOther)]), [fact({ actor_id: w.approver2.userId, agency_id: w.A.agencyId, action: "CMD026", outcome: "DENY", reason_code: "NOT_APPROVAL_CONTROLLER" })]);
  assert.equal(outcome(w, await withdraw(w.approver, 4)), "409 STALE_VERSION -", "the controller learns the version");

  completed<WithdrawApprovalView>(await withdraw(w.owner, 5), 200);
  const withdrawnOther = await withdraw(w.approver2, 6);
  assert.equal(outcome(w, withdrawnOther), "403 NOT_AUTHORIZED NOT_APPROVAL_CONTROLLER", "the withdrawn approval still has its controllers");
  assert.deepEqual(await facts("correlation_id = $1", [correlationOf(withdrawnOther)]), [fact({ actor_id: w.approver2.userId, agency_id: w.A.agencyId, action: "CMD026", outcome: "DENY", reason_code: "NOT_APPROVAL_CONTROLLER" })]);
  assert.equal(outcome(w, await withdraw(w.approver, 6)), "409 PRECONDITION_FAILED PLAN_NOT_APPROVED");
  assert.equal(outcome(w, await withdraw(w.owner, 5)), "409 STALE_VERSION -");

  // a VALIDATED plan carries no approval: nobody's control is at stake, and any approver learns its state
  const neverApproved = await w.approvable(w.A, projectId, "r18-never");
  assert.equal(outcome(w, await withdraw(w.approver2, 4, neverApproved.planId)), "409 PRECONDITION_FAILED PLAN_NOT_APPROVED");
  assert.equal(outcome(w, await withdraw(w.approver2, 3, neverApproved.planId)), "409 STALE_VERSION -");
});

test("N1 RACE: a disable issued by the platform while CreateAgency is in flight waits for it and survives — the command's identity sync never writes the security status back; a disable committed first refuses the command", async () => {
  // Re-check finding N1 (V-R16a): the authorizer read the stored identity without a lock and CreateAgency's sync wrote the
  // token's ACTIVE over a DISABLED committed meanwhile. Now the authorizer reads the identity after its transition lock
  // (D-TX-2), so the disable is ordered after the command, and the sync never writes `state` (the request-handler role holds no
  // privilege on it).
  const founder = await w.person("n1-founder");
  const platform = await w.h.pg.connect("postgres");
  try {
    await platform.query("SET application_name = 'kauro-test-platform'");
    const hold = w.holds.arm("journal.reserved");
    const request = call(w, { url: routes.createAgency(), token: founder.token, agency: null, key: freshKey("n1-race"), body: { displayName: "Race Founder Agency" } });
    await hold.reached;
    const disable = platform.query("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [founder.userId]);
    try {
      // the platform's disable waits for the in-flight command (it would have committed at once before the fix)
      await waitForLockWait(w.h.oracle, "kauro-test-platform", "UPDATE kauro.identities");
    } finally {
      hold.release();
    }
    completed<{ agency: AgencyView; membership: MembershipView }>(await request, 201);
    assert.equal((await disable).rowCount, 1);
  } finally {
    await platform.end();
  }
  assert.equal((await w.row<{ state: string }>("identities", "user_id = $1", [founder.userId]))?.state, "DISABLED", "the disable ordered after the command survives it");
  // once DISABLED, every command of that identity is refused whatever its token says
  const again = await call(w, { url: routes.createAgency(), token: founder.token, agency: null, body: { displayName: "After the disable" } });
  assert.equal(outcome(w, again), "403 NOT_AUTHORIZED IDENTITY_DISABLED");
});

test("N1: the identity a disable restricts cannot lift it — its own runtime session is refused (42501) and every command stays IDENTITY_DISABLED; only the platform re-enables it", async () => {
  // Re-check finding N1 (V-R16b): identities_self FOR ALL plus the UPDATE grant let the request-handler role re-enable its own
  // DISABLED row with one UPDATE.
  const member = await w.person("n1-member");
  await w.h.addMember(w.A, member.userId, "OPERATOR");
  await w.h.oracle.query("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [member.userId]);
  const body = { displayName: "N1 client", processingAuthorityRef: w.authorityA };
  assert.equal(outcome(w, await call(w, { url: routes.createClient(w.A.agencyId), token: member.token, agency: null, body })), "403 NOT_AUTHORIZED IDENTITY_DISABLED");
  const session = await w.h.appPool.raw.connect();
  try {
    await session.query("BEGIN");
    await session.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [w.A.agencyId, member.userId]);
    await assert.rejects(session.query("UPDATE kauro.identities SET state = 'ACTIVE' WHERE user_id = $1", [member.userId]), (e: unknown) => (e as { code?: string }).code === "42501");
    await session.query("ROLLBACK");
  } finally {
    session.release();
  }
  assert.equal(outcome(w, await call(w, { url: routes.createClient(w.A.agencyId), token: member.token, agency: null, body })), "403 NOT_AUTHORIZED IDENTITY_DISABLED");
  await w.h.oracle.query("UPDATE kauro.identities SET state = 'ACTIVE' WHERE user_id = $1", [member.userId]);
  completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), token: member.token, agency: null, body }), 201);
});

test("N3 RACE: a revocation queued behind a member's in-flight command is never overtaken by that member's later commands — the next command waits behind it and is refused NOT_A_MEMBER", async () => {
  const p = await w.person("n3-member");
  const membershipId = await w.h.addMember(w.A, p.userId, "OPERATOR");
  const body = (label: string) => ({ displayName: label, processingAuthorityRef: w.authorityA });
  const hold = w.holds.arm("journal.commit");
  const first = call(w, { url: routes.createClient(w.A.agencyId), token: p.token, agency: null, body: body("N3 first") });
  await hold.reached;
  const revoker = await ownerTransaction();
  const revocation = moveMembership(revoker, membershipId, { state: "REVOKED" })
    .then(() => revoker.query("COMMIT"))
    .then(
      () => null,
      async (e: unknown) => {
        await revoker.query("ROLLBACK");
        return e;
      },
    )
    .finally(() => revoker.release());
  let second: Promise<Reply> | null = null;
  try {
    await waitForLockWait(w.h.oracle, HARNESS_APP_POOL, "UPDATE kauro.memberships");
    // the revocation is queued; the member's next command waits behind it instead of joining the in-flight one
    second = call(w, { url: routes.createClient(w.A.agencyId), token: p.token, agency: null, body: body("N3 second") });
    await waitForApiLockWait(w, "await_transition('kauro.memberships'");
  } finally {
    hold.release();
  }
  completed<EndClientView>(await first, 201);
  assert.equal(await revocation, null, "the revocation commits after the in-flight command");
  if (second === null) throw new Error("the later request was never started");
  assert.equal(outcome(w, await second), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(await w.count("end_clients", "display_name = 'N3 second'"), 0);
});

test("N11: a VIEWER's own runtime session cannot make itself OWNER in the database — the promotion is refused (KA010) and the VIEWER still cannot archive a client through the route", async () => {
  // Re-check finding N11 (P7): memberships_tenant FOR ALL let any member's session rewrite its own role.
  const viewerRow = await w.row<{ version: string }>("memberships", "membership_id = $1", [w.memberships.viewer]);
  const session = await w.h.pg.connect("kauro_app_test");
  try {
    await session.query("BEGIN");
    await session.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [w.A.agencyId, w.viewer.userId]);
    await assert.rejects(
      session.query("UPDATE kauro.memberships SET role = 'OWNER', version = version + 1 WHERE membership_id = $1", [w.memberships.viewer]),
      (e: unknown) => (e as { code?: string }).code === "KA010",
    );
    await session.query("ROLLBACK");
  } finally {
    await session.end();
  }
  assert.deepEqual(await w.row<{ role: string; version: string }>("memberships", "membership_id = $1", [w.memberships.viewer]).then((r) => r && { role: r.role, version: r.version }), { role: "VIEWER", version: viewerRow?.version });
  assert.equal(outcome(w, await call(w, { url: routes.archiveClient(w.clientA), token: w.viewer.token, body: { expectedVersion: 1 } })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
});

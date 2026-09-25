// The security_events policies on real PostgreSQL 17 (review record docs/design/B06-review/A-pipeline-authorization.md, R2
// and R26; 08 "Audit events and retention": security events record actor, scope, action, outcome, policy version,
// assurance class, correlation and time; 08 "Database isolation": RLS applies visibility and writes through USING and WITH
// CHECK). The request-handler role writes three kinds of fact and nothing else:
//   - a fact in an agency's stream, only by a caller who holds a live membership in that agency, as itself, in that context;
//   - a fact in the caller's own identity stream (no agency), which may name the agency the request selected;
//   - an anonymous DENY (no user, no agency bound), the denial of a request that carried no authenticated subject.
// An agency's runtime role reads its own stream only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CausationId, UserId } from "@kauro/domain";
import { clock, ids, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";

let h: Harness;
let alice: UserId;
let bob: UserId;
let carol: UserId;
let A: AgencyFixture;
let B: AgencyFixture;

before(async () => {
  h = await start();
  alice = await h.person("alice-security");
  bob = await h.person("bob-security");
  carol = await h.person("carol-security");
  A = await h.createAgency(alice, "Agency A");
  B = await h.createAgency(bob, "Agency B");
});
after(async () => {
  await h.stop();
});

interface Row {
  readonly agencyId: string | null;
  readonly requestedAgencyId?: string | null;
  readonly actorKind: "USER" | "SERVICE" | "SYSTEM" | "ANONYMOUS";
  readonly actorId: string | null;
  readonly outcome?: "ALLOW" | "DENY";
  readonly assuranceClass?: "NONE" | "SESSION" | "STEP_UP";
}

/** Inserts one fact as the request-handler role under the given context; returns the SQLSTATE of a refusal, or null. */
async function insertAs(context: { readonly agencyId?: string; readonly userId?: string }, row: Row): Promise<string | null> {
  const c = await h.appPool.raw.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [context.agencyId ?? "", context.userId ?? ""]);
    await c.query(
      `INSERT INTO kauro.security_events (security_event_id, agency_id, requested_agency_id, actor_kind, actor_id, action, outcome, reason_code, policy_version, assurance_class, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'CMD009', $6, 'PROBE_REASON', 'B06-1', $7, $8, now())`,
      [ids.next(), row.agencyId, row.requestedAgencyId ?? null, row.actorKind, row.actorId, row.outcome ?? "DENY", row.assuranceClass ?? "SESSION", ids.next()],
    );
    await c.query("COMMIT");
    return null;
  } catch (e) {
    await c.query("ROLLBACK");
    const code = (e as { code?: unknown }).code;
    if (typeof code !== "string") throw e;
    return code;
  } finally {
    c.release();
  }
}

const RLS_REFUSED = "42501";
const CHECK_REFUSED = "23514";

test("R2: a fact in an agency's stream needs the writer's live membership in that agency — an outsider bound to the agency's context is refused, a member is admitted, a revoked member is refused, and nobody writes as someone else", async () => {
  // the outsider (carol, no membership anywhere) binds agency B's context and writes into B's stream: refused
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: carol }, { agencyId: B.agencyId, actorKind: "USER", actorId: carol }), RLS_REFUSED);
  // a member of A binds B's context: still an outsider of B
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: alice }, { agencyId: B.agencyId, actorKind: "USER", actorId: alice }), RLS_REFUSED);
  // B's owner writes into B's stream: admitted; but not in another person's name, nor into A's stream from B's context
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: bob }, { agencyId: B.agencyId, actorKind: "USER", actorId: bob }), null);
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: bob }, { agencyId: B.agencyId, actorKind: "USER", actorId: carol }), RLS_REFUSED);
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: bob }, { agencyId: A.agencyId, actorKind: "USER", actorId: bob }), RLS_REFUSED);

  // a member of A (live) writes into A's stream; once revoked, the same write is refused
  const membershipId = await h.addMember(A, carol, "VIEWER");
  assert.equal(await insertAs({ agencyId: A.agencyId, userId: carol }, { agencyId: A.agencyId, actorKind: "USER", actorId: carol }), null);
  await h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
    const revoked = await uow.memberships.transition(membershipId, 1, { state: "REVOKED", revokedAt: clock.now() }, clock.now());
    assert.equal(revoked.kind, "APPLIED");
    await uow.events.publish({ aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "membership.revoked.v1", actor: { kind: "USER", userId: alice }, causationId: ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { membershipId, agencyId: A.agencyId, byMembershipId: A.ownerMembershipId, reasonCode: "LEFT" } });
  });
  assert.equal(await insertAs({ agencyId: A.agencyId, userId: carol }, { agencyId: A.agencyId, actorKind: "USER", actorId: carol }), RLS_REFUSED);
});

test("R2/R26: an identity-owned fact belongs to its writer — it may name the agency the request selected, which need not exist; it is never both in a stream and naming another agency", async () => {
  const nonexistent = ids.next();
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: carol }, { agencyId: null, requestedAgencyId: B.agencyId, actorKind: "USER", actorId: carol }), null);
  assert.equal(await insertAs({ agencyId: nonexistent, userId: carol }, { agencyId: null, requestedAgencyId: nonexistent, actorKind: "USER", actorId: carol }), null, "no foreign key: naming a nonexistent agency is not an existence probe");
  assert.equal(await insertAs({ userId: carol }, { agencyId: null, actorKind: "USER", actorId: carol }), null);
  assert.equal(await insertAs({ userId: carol }, { agencyId: null, actorKind: "USER", actorId: alice }), RLS_REFUSED, "not in another person's name");
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: bob }, { agencyId: B.agencyId, requestedAgencyId: A.agencyId, actorKind: "USER", actorId: bob }), CHECK_REFUSED);
});

test("R26: the anonymous fact — written with no user and no agency bound, by nobody, as a DENY of assurance NONE; refused under any user context, as an ALLOW, or in a stream", async () => {
  assert.equal(await insertAs({}, { agencyId: null, actorKind: "ANONYMOUS", actorId: null, assuranceClass: "NONE" }), null);
  assert.equal(await insertAs({}, { agencyId: null, requestedAgencyId: A.agencyId, actorKind: "ANONYMOUS", actorId: null, assuranceClass: "NONE" }), null);
  assert.equal(await insertAs({ userId: carol }, { agencyId: null, actorKind: "ANONYMOUS", actorId: null, assuranceClass: "NONE" }), RLS_REFUSED);
  assert.equal(await insertAs({ agencyId: A.agencyId }, { agencyId: null, actorKind: "ANONYMOUS", actorId: null, assuranceClass: "NONE" }), RLS_REFUSED);
  assert.equal(await insertAs({}, { agencyId: null, actorKind: "ANONYMOUS", actorId: null, outcome: "ALLOW", assuranceClass: "NONE" }), CHECK_REFUSED);
  assert.equal(await insertAs({}, { agencyId: null, actorKind: "ANONYMOUS", actorId: null, assuranceClass: "SESSION" }), CHECK_REFUSED);
  // in a stream: the policy refuses it before the table's CHECK is evaluated (PostgreSQL checks RLS WITH CHECK first)
  assert.equal(await insertAs({}, { agencyId: A.agencyId, actorKind: "ANONYMOUS", actorId: null, assuranceClass: "NONE" }), RLS_REFUSED);
  assert.equal(await insertAs({}, { agencyId: null, actorKind: "ANONYMOUS", actorId: "someone", assuranceClass: "NONE" }), CHECK_REFUSED);
  // the other actor kinds are the control plane's, never the request handler's
  assert.equal(await insertAs({}, { agencyId: null, actorKind: "SYSTEM", actorId: null, assuranceClass: "NONE" }), RLS_REFUSED);
});

test("R2: an agency's runtime role reads its own stream only — never another agency's facts, never an identity-owned or anonymous fact that names it", async () => {
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: bob }, { agencyId: B.agencyId, actorKind: "USER", actorId: bob }), null);
  assert.equal(await insertAs({ agencyId: A.agencyId, userId: alice }, { agencyId: A.agencyId, actorKind: "USER", actorId: alice }), null);
  assert.equal(await insertAs({ agencyId: B.agencyId, userId: carol }, { agencyId: null, requestedAgencyId: B.agencyId, actorKind: "USER", actorId: carol }), null);
  assert.equal(await insertAs({}, { agencyId: null, requestedAgencyId: B.agencyId, actorKind: "ANONYMOUS", actorId: null, assuranceClass: "NONE" }), null);
  const c = await h.appPool.raw.connect();
  let visible: ReadonlyArray<{ agency_id: string | null; requested_agency_id: string | null }>;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [B.agencyId, bob]);
    visible = (await c.query<{ agency_id: string | null; requested_agency_id: string | null }>("SELECT agency_id, requested_agency_id FROM kauro.security_events")).rows;
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  assert.ok(visible.length > 0, "B's own facts are readable");
  assert.ok(visible.every((x) => x.agency_id === B.agencyId), "only B's stream");
  const namingB = await h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.security_events WHERE agency_id IS NULL AND requested_agency_id = $1", [B.agencyId]);
  assert.ok(Number(namingB.rows[0]?.n) >= 2, "the oracle sees the facts that name B, which B's role cannot");
});

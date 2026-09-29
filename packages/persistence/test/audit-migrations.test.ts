// Audit authority at the database (package B08, mandate B08-PERSISTENCE-AUDIT; migration 0021; docs/design/B08-audit-approval-jobs.md
// §3, §8.1, §9, D8-GRANT-1, D8-GRANT-2, D8-AUD-1; case map docs/design/B08-case-map.md R2-044): cost grants, audits and dispatch
// intents on real PostgreSQL 17 through the runtime login roles. Every guard is proven by the forbidden write performed AS THE ROLE
// that would perform it — the request handlers (kauro_app_test under the owner's TENANT context) carving an AUDIT grant and starting
// an audit, the control plane (kauro_control_test) funding the platform's pool and reserving dispatch intents — and refused beside the
// legitimate write that commits (21 "Positive and negative symmetry"). The one interleaving is fixed by a lock wait observed in
// pg_stat_activity (settlesOrWaits), never by a sleep; instants past a deadline come from the labelled TEST CLOCK (D8-CLOCK-1).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { AUDIT_POLICY } from "@kauro/domain";
import { backendPid, settlesOrWaits } from "../src/testing/harness.js";
import { fundPlatformPool } from "../src/testing/audit-fixtures.js";
import { clockAt } from "../src/testing/source-lifecycle.js";
import { commerceEvent, service, tenant, within } from "./commerce-support.js";
import { auditSubject, closeAuditEnv, openAuditEnv, type AuditEnv, type AuditSubject } from "./audit-support.js";
import { causeState, refused, refusedTransaction } from "./execution-support.js";
import type { AgencyFixture } from "../src/testing/harness.js";
import { ids, sha } from "./support.js";

let env: AuditEnv;

before(async () => {
  env = await openAuditEnv("audit-mig");
});
after(async () => {
  await closeAuditEnv(env);
});

const owner = (ag: AgencyFixture) => ({ kind: "USER", id: ag.ownerUserId }) as const;
const CONTROL = { kind: "SERVICE", id: "control-plane" } as const;

/** StartAudit's carve as the request handlers write it: an AUDIT grant of the agency born PREPARED (v1) from `pool`. */
async function carveGrant(c: Client, ag: AgencyFixture, pool: string, ceilingCents: bigint = 150n, grantId: string = ids.next()): Promise<string> {
  await c.query(
    `INSERT INTO kauro.cost_grants (grant_id, agency_id, grant_kind, pool_grant_id, currency, ceiling_cents, price_profile_hash)
     VALUES ($1, $2, 'AUDIT', $3, 'USD', $4, $5)`,
    [grantId, ag.agencyId, pool, ceilingCents.toString(), sha("price-profile-r2")],
  );
  await commerceEvent(c, "cost_grant", grantId, 1, ag.agencyId, "cost_grant.prepared.v1", owner(ag));
  return grantId;
}

/** actual_authorization_and_funding of an AUDIT grant (v2): its pool is its authorization and holds its ceiling. */
async function authorizeGrant(c: Client, ag: AgencyFixture, grantId: string, pool: string): Promise<void> {
  await c.query("UPDATE kauro.cost_grants SET version = 2, state = 'AUTHORIZED', authorization_ref = $2 WHERE grant_id = $1", [grantId, pool]);
  await commerceEvent(c, "cost_grant", grantId, 2, ag.agencyId, "cost_grant.authorized.v1", owner(ag));
}

/** An audit of the subject born QUEUED (v1) naming `grantId`, as StartAudit writes it. */
async function insertAudit(c: Client, ag: AgencyFixture, s: AuditSubject, grantId: string, auditId: string = ids.next()): Promise<string> {
  await c.query(
    `INSERT INTO kauro.audits (audit_id, agency_id, project_id, revision_id, revision_hash, target_contract_id, target_contract_hash, audit_policy_version, requested_by_membership_id, grant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'R2-INITIAL', $8, $9)`,
    [auditId, ag.agencyId, s.projectId, s.revisionId, s.revisionHash, s.contractId, s.targetContractHash, ag.ownerMembershipId, grantId],
  );
  await commerceEvent(c, "audit", auditId, 1, ag.agencyId, "audit.queued.v1", owner(ag));
  return auditId;
}

/** A committed StartAudit of the subject (carve, authorization, audit) from `pool`; its grant and audit. */
async function startedAudit(ag: AgencyFixture, s: AuditSubject, pool: string): Promise<{ grantId: string; auditId: string }> {
  return within(env.app, tenant(ag), async (c) => {
    const grantId = await carveGrant(c, ag, pool);
    await authorizeGrant(c, ag, grantId, pool);
    return { grantId, auditId: await insertAudit(c, ag, s, grantId) };
  });
}

/** A dispatch intent of the control plane: one physical attempt of a logical task reserving `cents` on `grantId`. */
function dispatchIntent(c: Client, agencyId: string | null, grantId: string, cents: number, requestId: string = ids.next()): Promise<unknown> {
  return c.query(
    `INSERT INTO kauro.request_journal (request_id, task_id, agency_id, request_hash, fence, reserved_cents, cost_grant_id, upstream_request_ids, reserved_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, ARRAY[]::uuid[], now(), now())`,
    [requestId, ids.next(), agencyId, sha(`request-${requestId}`), cents, grantId],
  );
}

/** A grant's money as stored (oracle). */
async function grantRow(grantId: string): Promise<{ state: string; version: number; ceiling: number; reserved: number; spent: number; authorization_ref: string | null }> {
  const r = await env.h.oracle.query(
    "SELECT state, version::int AS version, ceiling_cents::int AS ceiling, reserved_cents::int AS reserved, reconciled_spend_cents::int AS spent, authorization_ref::text AS authorization_ref FROM kauro.cost_grants WHERE grant_id = $1",
    [grantId],
  );
  assert.ok(r.rows[0], `grant ${grantId}`);
  return r.rows[0];
}

test("R2-044 at the database: an audit commits only with a reservation on an AUTHORIZED, unexpired grant with room under its ceiling, and a dispatch intent is refused KA083 unless its reservation fits a funded grant", async () => {
  const { A, B } = env;
  // the platform's monthly model pool, funded by the control plane's operations act (Q8-1): nothing is reserved on it yet, and the
  // revisions sealed below reserved nothing either (sealing never funds an audit, D8-GRANT-1)
  const pool = await fundPlatformPool(env.control, { ceilingCents: 1_000n });
  const s1 = await auditSubject(env, A, "r2-044-one");
  const s2 = await auditSubject(env, A, "r2-044-two");
  const s3 = await auditSubject(env, A, "r2-044-three");
  const sB = await auditSubject(env, B, "r2-044-b");
  const funded = await grantRow(pool);
  assert.deepEqual([funded.state, funded.version, funded.ceiling, funded.reserved, funded.spent], ["AUTHORIZED", 2, 1000, 0, 0]);
  assert.ok(funded.authorization_ref !== null, "the pool names the owner's funding evidence");
  const noGrants = await env.h.oracle.query("SELECT count(*)::int AS n FROM kauro.cost_grants WHERE agency_id = ANY($1::uuid[])", [[A.agencyId, B.agencyId]]);
  assert.equal(noGrants.rows[0].n, 0, "the seals reserved nothing");

  // --- the audit's reservation (KA083) ------------------------------------------------------------------------------------------
  await within(env.app, tenant(A), async (c) => {
    // no grant at all, a grant that was never authorized, a grant of another agency's audit: nothing funds the audit
    await refused(c, () => insertAudit(c, A, s1, ids.next()), "KA083", "an audit naming no grant");
    const prepared = await carveGrant(c, A, pool);
    await refused(c, () => insertAudit(c, A, s1, prepared), "KA083", "an audit on a PREPARED grant");
    // the request handlers carve only AUDIT grants of their own agency within the free-audit policy, from a platform pool
    await refused(c, () => carveGrant(c, A, pool, BigInt(AUDIT_POLICY.freeAuditCeilingCents + 1)), "23514", "an AUDIT grant above the free-audit ceiling", "cost_grants_audit_ceiling");
    await refused(c, () => carveGrant(c, A, prepared), "KA083", "an AUDIT grant carved from another AUDIT grant");
    await refused(
      c,
      () => c.query("INSERT INTO kauro.cost_grants (grant_id, grant_kind, currency, ceiling_cents, price_profile_hash, expires_at) VALUES ($1, 'PLATFORM_MONTHLY', 'USD', 1000, $2, now() + interval '30 days')", [ids.next(), sha("price")]),
      "42501",
      "a request handler funds no platform pool",
    );
    // nor moves a pool's reservation by hand, in either direction: the carve's authorization moves it (one trigger level deeper)
    await refused(c, () => c.query("UPDATE kauro.cost_grants SET reserved_cents = reserved_cents + 150 WHERE grant_id = $1", [pool]), "KA083", "a hand-made pool reservation");
  });
  const b = await startedAudit(B, sB, pool);
  await within(env.app, tenant(A), async (c) => {
    await refused(c, () => insertAudit(c, A, s1, b.grantId), "KA083", "an audit on another agency's grant");
  });
  // a pool without room refuses the carve's authorization: its ceiling CHECK, under the pool's row lock
  const small = await fundPlatformPool(env.control, { ceilingCents: 100n });
  await refusedTransaction(
    env.app,
    tenant(A),
    async (c) => authorizeGrant(c, A, await carveGrant(c, A, small), small),
    "23514",
    "a carve beyond the pool's room",
  );
  assert.equal((await grantRow(small)).reserved, 0);
  // an AUTHORIZED grant past its expiry (the audit's absolute window, stood in by the TEST CLOCK) funds nothing
  const late = await within(env.app, tenant(A), async (c) => {
    const grantId = await carveGrant(c, A, pool);
    await authorizeGrant(c, A, grantId, pool);
    return grantId;
  });
  await refusedTransaction(
    env.app,
    tenant(A),
    async (c) => {
      await clockAt(c, new Date(Date.now() + (AUDIT_POLICY.auditAbsoluteSeconds + 3_600) * 1000));
      await insertAudit(c, A, s1, late);
    },
    "KA083",
    "an audit on an expired grant",
  );
  // an AUTHORIZED grant whose ceiling its dispatch intents already reserve has no room left
  await within(env.control, service(A.agencyId), (c) => dispatchIntent(c, A.agencyId, late, 150));
  await refusedTransaction(env.app, tenant(A), (c) => insertAudit(c, A, s1, late), "KA083", "an audit on a grant without room");

  // --- the legitimate StartAudit commits: its grant AUTHORIZED and held on the pool, the audit QUEUED with its deadlines ------------
  const heldBefore = (await grantRow(pool)).reserved;
  const a1 = await startedAudit(A, s1, pool);
  assert.equal((await grantRow(pool)).reserved, heldBefore + 150, "the pool holds exactly the AUDIT grant's ceiling");
  assert.deepEqual(await grantRow(a1.grantId), { state: "AUTHORIZED", version: 2, ceiling: 150, reserved: 0, spent: 0, authorization_ref: pool });
  const [audit] = (
    await env.h.oracle.query(
      `SELECT state, version::int AS version, fence::int AS fence, cancel_version::int AS cancel_version,
              extract(epoch FROM absolute_deadline_at - started_at)::int AS window, interpretation_deadline_at, grant_id::text AS grant_id,
              started_at = created_at AS stamped
         FROM kauro.audits WHERE audit_id = $1`,
      [a1.auditId],
    )
  ).rows;
  assert.deepEqual(audit, { state: "QUEUED", version: 1, fence: 0, cancel_version: 0, window: AUDIT_POLICY.auditAbsoluteSeconds, interpretation_deadline_at: null, grant_id: a1.grantId, stamped: true });
  // one audit per grant, per (revision, target) and one live audit per agency (D8-AUD-1)
  await refusedTransaction(env.app, tenant(A), (c) => insertAudit(c, A, s2, a1.grantId), "23505", "a second audit on one grant");
  await within(env.app, tenant(A), async (c) => {
    const grantId = await carveGrant(c, A, pool);
    await authorizeGrant(c, A, grantId, pool);
    await refused(c, () => insertAudit(c, A, s2, grantId), "23505", "a second live audit of the agency", "audits_one_live_per_agency");
    // the first audit ends (CancelAudit's cancellation_wins); a retry of its subject is not a new free audit
    await c.query("UPDATE kauro.audits SET version = 2, state = 'CANCELLED', cancel_version = 1, cancel_actor_kind = 'USER', cancel_actor_id = $2, terminal_reason = 'AGENCY_CANCELLED' WHERE audit_id = $1", [a1.auditId, A.ownerUserId]);
    await commerceEvent(c, "audit", a1.auditId, 2, A.agencyId, "audit.cancelled.v1", owner(A));
    await refused(c, () => insertAudit(c, A, s1, grantId), "23505", "a second audit of one revision and target", "audits_one_per_subject");
    await insertAudit(c, A, s2, grantId);
  });

  // --- dispatch intents reserve on a funded grant (D8-GRANT-2) ----------------------------------------------------------------------
  const a3 = await within(env.app, tenant(A), async (c) => {
    // the live audit of s2 ends first (one live audit per agency)
    const live = await c.query<{ audit_id: string }>("SELECT audit_id FROM kauro.audits WHERE revision_id = $1", [s2.revisionId]);
    await c.query("UPDATE kauro.audits SET version = 2, state = 'CANCELLED', cancel_version = 1, cancel_actor_kind = 'USER', cancel_actor_id = $2, terminal_reason = 'AGENCY_CANCELLED' WHERE audit_id = $1", [live.rows[0]!.audit_id, A.ownerUserId]);
    await commerceEvent(c, "audit", live.rows[0]!.audit_id, 2, A.agencyId, "audit.cancelled.v1", owner(A));
    const grantId = await carveGrant(c, A, pool);
    await authorizeGrant(c, A, grantId, pool);
    return { grantId, auditId: await insertAudit(c, A, s3, grantId) };
  });
  await within(env.control, service(A.agencyId), async (c) => {
    const prepared = (await c.query<{ grant_id: string }>("SELECT grant_id FROM kauro.cost_grants WHERE agency_id = $1 AND state = 'PREPARED' LIMIT 1", [A.agencyId])).rows[0]!.grant_id;
    await refused(c, () => dispatchIntent(c, A.agencyId, ids.next(), 10), "KA083", "an intent naming no grant");
    await refused(c, () => dispatchIntent(c, A.agencyId, prepared, 10), "KA083", "an intent on a PREPARED grant");
    await refused(c, () => dispatchIntent(c, A.agencyId, b.grantId, 10), "KA083", "an intent of agency A on agency B's grant");
    await refused(c, () => dispatchIntent(c, null, a3.grantId, 10), "KA083", "a tenant-less intent on an agency's grant");
    await refused(c, () => dispatchIntent(c, A.agencyId, a3.grantId, 151), "KA083", "an intent above the grant's ceiling");
    // the control plane edits a grant's money only within its ceiling (the CHECK the reservations live under)
    await refused(c, () => c.query("UPDATE kauro.cost_grants SET reserved_cents = 151 WHERE grant_id = $1", [a3.grantId]), "23514", "a reservation past the ceiling", "cost_grants_within_ceiling");
    await dispatchIntent(c, A.agencyId, a3.grantId, 100);
    await refused(c, () => dispatchIntent(c, A.agencyId, a3.grantId, 51), "KA083", "an intent past the grant's remaining room");
  });
  assert.deepEqual([(await grantRow(a3.grantId)).reserved, (await grantRow(a3.grantId)).spent], [100, 0], "exactly the committed reservation is held");
  // a platform pool funds a tenant-less intent as well as an agency's
  await within(env.control, service(A.agencyId), (c) => dispatchIntent(c, null, pool, 5));
  // an expired grant (TEST CLOCK) and an EXHAUSTED one fund nothing
  await refusedTransaction(
    env.control,
    service(A.agencyId),
    async (c) => {
      await clockAt(c, new Date(Date.now() + (AUDIT_POLICY.auditAbsoluteSeconds + 3_600) * 1000));
      await dispatchIntent(c, A.agencyId, a3.grantId, 10);
    },
    "KA083",
    "an intent on an expired grant",
  );
  await within(env.control, service(A.agencyId), async (c) => {
    await c.query("UPDATE kauro.cost_grants SET version = 3, state = 'EXHAUSTED' WHERE grant_id = $1", [a3.grantId]);
    await commerceEvent(c, "cost_grant", a3.grantId, 3, A.agencyId, "cost_grant.exhausted.v1", CONTROL);
    await refused(c, () => dispatchIntent(c, A.agencyId, a3.grantId, 10), "KA083", "an intent on an EXHAUSTED grant");
    // reconciliation finds room left under the ceiling (100 of 150 reserved): the grant is AUTHORIZED again
    await c.query("UPDATE kauro.cost_grants SET version = 4, state = 'AUTHORIZED' WHERE grant_id = $1", [a3.grantId]);
    await commerceEvent(c, "cost_grant", a3.grantId, 4, A.agencyId, "cost_grant.authorized.v1", CONTROL);
  });

  // two intents for the grant's last cents serialize on its row: the second waits (pg_stat_activity), then finds no room (KA083)
  const second = await env.h.pg.connect("kauro_control_test");
  try {
    await env.control.query("BEGIN");
    await env.control.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true), set_config('kauro.finance_agency_id', '', true)", [A.agencyId]);
    await dispatchIntent(env.control, A.agencyId, a3.grantId, 50);
    await second.query("BEGIN");
    await second.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true), set_config('kauro.finance_agency_id', '', true)", [A.agencyId]);
    const pid = await backendPid(second);
    const observed = await settlesOrWaits(env.h.oracle, pid, dispatchIntent(second, A.agencyId, a3.grantId, 50), "the second intent for the last cents");
    assert.equal(observed.kind, "WAITING", "the second intent waits on the grant's row");
    await env.control.query("COMMIT");
    const outcome = observed.kind === "WAITING" ? await observed.pending : observed.outcome;
    assert.equal(outcome.status, "rejected");
    assert.equal(causeState(outcome.status === "rejected" ? outcome.reason : null), "KA083", "the loser finds the last cents reserved");
    await second.query("ROLLBACK");
  } finally {
    await second.end();
  }
  assert.deepEqual([(await grantRow(a3.grantId)).reserved, (await grantRow(a3.grantId)).state], [150, "AUTHORIZED"], "one of the two reserved the last cents");
  const intents = await env.h.oracle.query("SELECT count(*)::int AS n, sum(reserved_cents)::int AS cents FROM kauro.request_journal WHERE cost_grant_id = $1", [a3.grantId]);
  assert.deepEqual(intents.rows[0], { n: 2, cents: 150 }, "every committed intent is exactly one reservation of the grant");
});

// The 6c cells of the B10 failure matrix on prospects, claims and attribution (docs/design/B10-failure-matrix.md "GAP list, by risk"
// items PROS_PAR, ATTR_PAR, CLAIM_DEADLINE, CLAIM_LAPSE_ACCEPT, AGREEMENT_EXP for CMD046), each a cell of the common fault harness
// (docs/design/FAULT-HARNESS.md). The REAL routes of CMD045..CMD048 run their REAL unit of work over a connection the harness opened
// (test/fault-support.ts), the CLAIM_WINDOWS sweep runs through the commission service routed the same way (test/b10-cells-support.ts):
// a partial cell fails a later write of the unit after an earlier one answered, a race cell holds one actor at a named point and observes
// the other waiting on it in pg_stat_activity, an expiry cell moves the controlled clock past the deadline and puts the instant on the
// command's own transaction (the database clock decides, D10-CLOCK-1). PostgreSQL 17 through the runtime login roles; the superuser only
// reads. Nothing sleeps a fixed time (a deadline crossed during a lock wait waits only the remainder the database measures, crossedWhileWaiting).
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { AttributionView, ProspectView, SalesAccountView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { organizationKeyOf } from "@kauro/domain";
import { connectionPid, EFFECT_CLOCK_MARGIN_MS, faultCell, openConnection, recordProspect, recordServiceAssignment, type FaultContext, type HarnessConnection, type RecordedSeller, invariantsAfterEach } from "@kauro/persistence/testing";
import { agentOf, assignedThrough, claimed, integrationWorld, oracleRows, seller, type IntegrationWorld } from "./integration-support.js";
import { bindCells, contend, crossedWhileWaiting, effectClockBefore, itemOf, mustHaveSettled, sweepOn, type Actor } from "./b10-cells-support.js";
import type { SqlStep } from "./fault-support.js";
import { asOperator, prepareAllocation, recordClaimEvidence, recordSourceEvidence } from "./sales-support.js";
import { call, completed, freshKey, ids, outcome, sha, type Person, type Reply } from "./support.js";

let iw: IntegrationWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => iw.h.oracle);
/** Every harness connection of these cells waits for a lock at most 60 s (lock_timeout): an ordering defect fails its cell, never hangs the file. */
const bounded = (login: Parameters<IntegrationWorld["h"]["pg"]["clientConfig"]>[0]): Promise<HarnessConnection> => openConnection({ ...iw.h.pg.clientConfig(login), options: "-c lock_timeout=60000" });
const open = bounded;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
});
after(async () => {
  await iw.stop();
});

const HOUR_S = 3600;
/** An instant of the database (microseconds) as epoch milliseconds, truncated. */
const msOf = (iso: string): number => Date.parse(iso.replace(/(\.\d{3})\d*Z$/, "$1Z"));
const REVIEW_HOURS = 2160;

/** The reply in a compact form: the status of a success, `status code reason` of a refusal. */
const said = (reply: Reply): string => (reply.status < 300 ? String(reply.status) : outcome(iw.w, reply));
const valueOf = <T>(r: PromiseSettledResult<T>, what: string): T => {
  if (r.status === "rejected") throw new Error(`${what} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, { cause: r.reason });
  return r.value;
};
/** Runs `fn`, then `then` whatever it did (a pause released after its waiter was observed, or failed to be). */
const afterward = async <T>(fn: () => Promise<T>, then: () => void): Promise<T> => {
  try {
    return await fn();
  } finally {
    then();
  }
};
const journalState = async (key: string): Promise<string | null> => (await iw.w.journal(key))?.state ?? null;

/** Runs `run` as the cell's partial operation: a 500 of the route is the failure it hid (a crash is not a DomainFailure). */
async function failsAt(ctx: FaultContext, what: string, at: string, run: (conn: HarnessConnection) => Promise<Reply>): Promise<void> {
  const conn = await open("kauro_app_test");
  try {
    await ctx.partial(what, at, async () => {
      const seen = iw.w.internalErrors.length;
      const reply = await run(conn);
      if (reply.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(`the unit failed: ${reply.status}`);
      return reply;
    });
  } finally {
    await conn.end();
  }
}

/** A route of the api run over `conn` (the unit routed over the harness connection, its statement steps instrumented). */
const routed = (ctx: Pick<FaultContext, "points">, conn: HarnessConnection, steps: ReadonlyArray<SqlStep>, request: () => Promise<Reply>): Promise<Reply> => iw.faults.on(conn, "kauro_app", ctx.points, steps, request);

const JOURNAL_COMMIT: SqlStep = { label: "journal_commit", match: /UPDATE kauro\.command_journal SET state = 'COMMITTED'/ };

// --- the commands --------------------------------------------------------------------------------------------------------------------

const registerProspect = (who: Person, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: "/api/v1/sales/prospects", token: who.token, agency: null, key, body });
const claimProspect = (who: Person, prospectId: string, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/prospects/${prospectId}/claims`, token: who.token, agency: null, key, body });
const acceptClaim = (claimId: string, allocationId: string, key: string, expectedVersion = 1): Promise<Reply> =>
  call(iw.w, { url: `/api/v1/sales/claims/${claimId}/accept`, token: iw.owner.token, agency: null, key, body: { expectedVersion, shareAllocationRef: allocationId } });
const assignAccount = (agencyId: string, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/agencies/${agencyId}/assignment`, token: iw.owner.token, agency: null, key, body });

// --- what the superuser reads ----------------------------------------------------------------------------------------------------------

interface ClaimRow {
  readonly state: string;
  readonly version: number;
}
const claimsOf = async (claimIds: ReadonlyArray<string>): Promise<ReadonlyArray<readonly [string, number]>> => {
  const rows = await oracleRows<{ claim_id: string; state: string; version: string }>(iw, "SELECT claim_id, state, version::text FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[])", [claimIds]);
  return claimIds.map((id) => {
    const r = rows.find((x) => x.claim_id === id)!;
    return [r.state, Number(r.version)] as const;
  });
};
const claimOf = async (claimId: string): Promise<ClaimRow> => {
  const [r] = await claimsOf([claimId]);
  return { state: r![0], version: r![1] };
};
const allocationOf = async (allocationId: string): Promise<{ readonly frozen: boolean; readonly version: number; readonly shareBps: number }> => {
  const [r] = await oracleRows<{ frozen: boolean; version: string; share_bps: string }>(
    iw,
    "SELECT a.frozen_at IS NOT NULL AS frozen, a.version::text, (SELECT coalesce(sum(s.share_bps), 0)::text FROM kauro.allocation_shares s WHERE s.allocation_id = a.allocation_id) AS share_bps FROM kauro.attribution_allocations a WHERE a.allocation_id = $1",
    [allocationId],
  );
  return { frozen: r!.frozen, version: Number(r!.version), shareBps: Number(r!.share_bps) };
};

/**
 * A SUBMITTED claim of `s` on the prospect whose 2160-hour review deadline falls `inSeconds` from the database's instant now (negative:
 * already passed): the seller's own session writes it with the labelled TEST CLOCK standing 2160 hours earlier (D10-CLOCK-1). Returns the
 * claim and its deadline as the database holds it.
 */
async function claimDueIn(s: RecordedSeller, prospectId: string, inSeconds: number): Promise<{ readonly claimId: string; readonly deadline: string }> {
  const claimId = ids.next();
  const evidenceHash = sha(`claim-evidence-${claimId}`);
  await asOperator(iw.h, s.userId, async (c) => {
    await c.query("SELECT set_config('kauro_test.clock_offset_seconds', $1, true)", [String(-REVIEW_HOURS * HOUR_S + inSeconds)]);
    await c.query(
      `INSERT INTO kauro.claim_evidence (evidence_id, seller_id, prospect_id, evidence_hash, source_channel, first_meaningful_contact_at, qualified_need_hash, activity_kinds, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, 'DISCOVERY_CALL', kauro.server_now() - interval '2 days', $5, ARRAY['DISCOVERY_CALL', 'QUALIFIED_NEED']::text[], kauro.server_now(), now())`,
      [ids.next(), s.sellerId, prospectId, evidenceHash, sha(`need-${claimId}`)],
    );
    await c.query(
      `INSERT INTO kauro.attribution_claims (claim_id, prospect_id, seller_id, agreement_id, agreement_version, evidence_hash, submitted_at, review_deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), kauro.server_now() + interval '2160 hours', now(), now())`,
      [claimId, prospectId, s.sellerId, s.agreementId, s.agreementVersion, evidenceHash],
    );
  });
  const [row] = await oracleRows<{ deadline: string }>(iw, `SELECT to_char(review_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline FROM kauro.attribution_claims WHERE claim_id = $1`, [claimId]);
  return { claimId, deadline: row!.deadline };
}

/** An agency (buyer type AGENCY), a seller's prospect and its claim due `inSeconds` from now, and the owner's prepared allocation of it to the agency. */
async function dueOpportunity(label: string, inSeconds: number): Promise<{ readonly agencyId: string; readonly s: RecordedSeller; readonly claimId: string; readonly deadline: string; readonly allocationId: string }> {
  const s = await seller(iw, label);
  const a = await agentOf(iw, `${label}-agency`);
  const prospect = await recordProspect(iw.h, { by: s, domain: `${label}.example` });
  const { claimId, deadline } = await claimDueIn(s, prospect.prospectId, inSeconds);
  const allocationId = await prepareAllocation(iw.h, { ownerUserId: iw.owner.userId, agencyId: a.s.agency.agencyId, prospectId: prospect.prospectId, shares: [{ seller: s, claimId, shareBps: 10_000 }] });
  return { agencyId: a.s.agency.agencyId, s, claimId, deadline, allocationId };
}

// =====================================================================================================================================
// PROS_PAR: RegisterProspect and ClaimProspect, a failure after the prospect or claim insert
// =====================================================================================================================================

const PROSPECT_INSERT: SqlStep = { label: "prospect_insert", match: /INSERT INTO kauro\.prospects/ };
const CLAIM_INSERT: SqlStep = { label: "claim_insert", match: /INSERT INTO kauro\.attribution_claims/ };

faultCell(
  {
    id: "PROS_PAR",
    step: "CMD045 RegisterProspect / PARTIAL: W prospect + source-evidence binding (one COMMIT)",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the prospect insert (which carries its organization key and source-evidence binding) answered and before the journal's COMMITTED write rolls both back: no prospect of the organization key, no journal entry for the key; the same key then registers exactly one RESEARCHED prospect at version 1 owned by the seller, and its identical replay answers the journaled 201",
  },
  async (ctx) => {
    const s = await seller(iw, "pros-par-register");
    const domain = "pros-par-register.example";
    const evidence = await recordSourceEvidence(iw.h, { userId: s.userId, sellerId: s.sellerId }, { domain });
    const body = { organizationLabel: domain, businessContactRef: evidence.contactRef, sourceEvidenceHash: evidence.sourceEvidenceHash, jurisdiction: "United States" };
    const key = freshKey("pros-par-register");
    const organizationKey = organizationKeyOf(domain)!.key;
    const prospects = async (): Promise<ReadonlyArray<{ state: string; version: string; owner_seller_id: string | null; source_evidence_hash: string }>> =>
      oracleRows(iw, "SELECT state, version::text, owner_seller_id, source_evidence_hash FROM kauro.prospects WHERE organization_key = $1", [organizationKey]);

    await failsAt(ctx, "RegisterProspect failing after its prospect insert and before its journal's COMMITTED write", "db.journal_commit.before", (conn) =>
      routed(ctx, conn, [PROSPECT_INSERT, JOURNAL_COMMIT], () => registerProspect(s.person, key, body)),
    );
    assert.ok(ctx.points.passed.includes("db.prospect_insert.after"), "the prospect insert answered before the failure");
    assert.deepEqual(await prospects(), [], "no prospect of the organization key: the insert rolled back with the unit");
    assert.equal(await journalState(key), null, "no journal entry for the key");

    const retried = completed<ProspectView>(await registerProspect(s.person, key, body), 201);
    assert.equal(retried.replayed, false, "the same key executes once, after the rollback");
    assert.deepEqual([retried.data.state, retried.data.ownerSellerId, retried.data.sourceEvidenceHash], ["RESEARCHED", s.sellerId, evidence.sourceEvidenceHash]);
    assert.deepEqual(await prospects(), [{ state: "RESEARCHED", version: "1", owner_seller_id: s.sellerId, source_evidence_hash: evidence.sourceEvidenceHash }], "exactly one prospect, bound to its source evidence");
    assert.equal(await journalState(key), "COMMITTED");
    const replay = completed<ProspectView>(await registerProspect(s.person, key, body), 201);
    assert.deepEqual([replay.replayed, replay.data.prospectId], [true, retried.data.prospectId], "the identical replay answers the journaled 201");
    assert.equal((await prospects()).length, 1, "the replay writes nothing");
  },
);

faultCell(
  {
    id: "PROS_PAR",
    step: "CMD046 ClaimProspect / PARTIAL: W claim + deadline + conflict review (one COMMIT)",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the claim insert (its state from the conflict review and its 2160-hour review deadline in the same row) answered and before the journal's COMMITTED write rolls both back: no claim of the seller on the prospect, no journal entry; the same key then submits exactly one SUBMITTED claim whose review deadline is its submission plus 2160 hours",
  },
  async (ctx) => {
    const s = await seller(iw, "pros-par-claim");
    const prospect = await recordProspect(iw.h, { by: s, domain: "pros-par-claim.example" });
    const evidenceHash = await recordClaimEvidence(iw.h, s, prospect.prospectId);
    const body = { evidenceHash, agreementVersion: s.agreementVersion };
    const key = freshKey("pros-par-claim");
    const claims = async (): Promise<ReadonlyArray<{ state: string; version: string; exact: boolean }>> =>
      oracleRows(iw, "SELECT state, version::text, (review_deadline_at - submitted_at = interval '2160 hours') AS exact FROM kauro.attribution_claims WHERE prospect_id = $1 AND seller_id = $2", [prospect.prospectId, s.sellerId]);

    await failsAt(ctx, "ClaimProspect failing after its claim insert and before its journal's COMMITTED write", "db.journal_commit.before", (conn) =>
      routed(ctx, conn, [CLAIM_INSERT, JOURNAL_COMMIT], () => claimProspect(s.person, prospect.prospectId, key, body)),
    );
    assert.ok(ctx.points.passed.includes("db.claim_insert.after"), "the claim insert answered before the failure");
    assert.deepEqual(await claims(), [], "no claim: the insert rolled back with the unit");
    assert.equal(await journalState(key), null, "no journal entry for the key");

    const retried = completed<{ state: string }>(await claimProspect(s.person, prospect.prospectId, key, body), 201);
    assert.deepEqual([retried.replayed, retried.data.state], [false, "SUBMITTED"]);
    assert.deepEqual(await claims(), [{ state: "SUBMITTED", version: "1", exact: true }], "exactly one SUBMITTED claim, its review deadline 2160 hours after its submission");
  },
);

// =====================================================================================================================================
// ATTR_PAR: AcceptAttribution (allocation, shares, claims, competitors) and AssignAccount (end previous, append new), one failure per later write
// =====================================================================================================================================

const FREEZE: SqlStep = { label: "freeze", match: /UPDATE kauro\.attribution_allocations SET frozen_at/ };
const CLAIM_UPDATE = (label: string, nth: number): SqlStep => ({ label, match: /UPDATE kauro\.attribution_claims AS c SET/, nth });

faultCell(
  {
    id: "ATTR_PAR",
    step: "CMD047 AcceptAttribution / PARTIAL: W allocation + shares + claims state + pools terms (one COMMIT)",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the allocation is frozen, after the first beneficiary's claim ACCEPTED, after both beneficiaries' claims ACCEPTED and before the competing claim REJECTED, and after every claim update before the journal's COMMITTED write each rolls AcceptAttribution back (the allocation unfrozen at its version, the three claims SUBMITTED at version 1, no journal entry); the same key then accepts once: the allocation frozen with shares of 6000 and 4000 bps summing to 10000, the beneficiaries ACCEPTED and the competitor REJECTED",
  },
  async (ctx) => {
    const cases = [
      { label: "after-freeze", at: "db.claim_1.before", steps: [FREEZE, CLAIM_UPDATE("claim_1", 1)], done: ["db.freeze.after"] },
      { label: "between-beneficiaries", at: "db.claim_2.before", steps: [FREEZE, CLAIM_UPDATE("claim_1", 1), CLAIM_UPDATE("claim_2", 2)], done: ["db.freeze.after", "db.claim_1.after"] },
      { label: "before-competitor", at: "db.claim_3.before", steps: [FREEZE, CLAIM_UPDATE("claim_2", 2), CLAIM_UPDATE("claim_3", 3)], done: ["db.freeze.after", "db.claim_2.after"] },
      { label: "before-journal", at: "db.journal_commit.before", steps: [CLAIM_UPDATE("claim_3", 3), JOURNAL_COMMIT], done: ["db.claim_3.after"] },
    ] as const;
    for (const c of cases) {
      const label = `attr-par-${c.label}`;
      const a = await agentOf(iw, label);
      const att = await claimed(iw, label, 3);
      const allocationId = await prepareAllocation(iw.h, {
        ownerUserId: iw.owner.userId,
        agencyId: a.s.agency.agencyId,
        prospectId: att.prospectId,
        shares: [
          { seller: att.sellers[0]!, claimId: att.claimIds[0]!, shareBps: 6_000 },
          { seller: att.sellers[1]!, claimId: att.claimIds[1]!, shareBps: 4_000 },
        ],
      });
      const before = { allocation: await allocationOf(allocationId), claims: await claimsOf(att.claimIds) };
      assert.deepEqual(before.claims, [["SUBMITTED", 1], ["SUBMITTED", 1], ["SUBMITTED", 1]]);
      const key = freshKey(label);
      const passedBefore = ctx.points.passed.length;
      await failsAt(ctx, `AcceptAttribution failing ${c.label}`, c.at, (conn) => routed(ctx, conn, c.steps, () => acceptClaim(att.claimIds[0]!, allocationId, key)));
      const passed = ctx.points.passed.slice(passedBefore);
      for (const p of c.done) assert.ok(passed.includes(p), `${c.label}: ${p} answered before the failure`);
      assert.deepEqual({ allocation: await allocationOf(allocationId), claims: await claimsOf(att.claimIds) }, before, `${c.label}: the allocation unfrozen and every claim SUBMITTED at its version`);
      assert.equal(await journalState(key), null, `${c.label}: no journal entry`);

      const done = completed<AttributionView>(await acceptClaim(att.claimIds[0]!, allocationId, key), 200);
      assert.deepEqual([done.replayed, done.data.claim.state, done.data.beneficiaryCount, done.data.rejectedClaimCount], [false, "ACCEPTED", 2, 1], `${c.label}: the same key accepts once`);
      const allocation = await allocationOf(allocationId);
      assert.deepEqual([allocation.frozen, allocation.shareBps], [true, 10_000], `${c.label}: frozen with shares summing to 10000 bps`);
      assert.deepEqual((await claimsOf(att.claimIds)).map((x) => x[0]), ["ACCEPTED", "ACCEPTED", "REJECTED"], `${c.label}: the beneficiaries ACCEPTED, the competitor REJECTED`);
    }
  },
);

const LINK_INSERT: SqlStep = { label: "link_insert", match: /INSERT INTO kauro\.account_assignments/ };
const ACCOUNT_MOVE: SqlStep = { label: "account_move", match: /UPDATE kauro\.sales_accounts SET current_assignment_id/ };

faultCell(
  {
    id: "ATTR_PAR",
    step: "CMD048 AssignAccount / PARTIAL: W end previous assignment + append new current + service assignment link (one COMMIT)",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the new ASSIGNED link (superseding the previous one) is inserted and before the sales account moves to it, and one after the account moved and before the journal's COMMITTED write, each roll AssignAccount back: the account at version 1 with the previous seller current, one link, no journal entry; the same key then assigns once: version 2, the new seller current, exactly two links and one current assignment",
  },
  async (ctx) => {
    const cases = [
      { label: "after-link", at: "db.account_move.before", steps: [LINK_INSERT, ACCOUNT_MOVE], done: "db.link_insert.after" },
      { label: "after-move", at: "db.journal_commit.before", steps: [ACCOUNT_MOVE, JOURNAL_COMMIT], done: "db.account_move.after" },
    ] as const;
    for (const c of cases) {
      const label = `attr-par-assign-${c.label}`;
      const a = await agentOf(iw, label);
      const agencyId = a.s.agency.agencyId;
      const previous = await seller(iw, `${label}-previous`);
      const next = await seller(iw, `${label}-next`);
      const first = await assignedThrough(iw, agencyId, { expectedVersion: 0, sellerId: previous.sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: iw.owner.userId as UserId, agencyId, sellerId: previous.sellerId }) });
      assert.deepEqual([first.version, first.sellerId], [1, previous.sellerId]);
      const account = async () => {
        const [row] = await oracleRows<{ version: string; seller_id: string | null; links: string }>(
          iw,
          "SELECT s.version::text, c.seller_id, (SELECT count(*)::text FROM kauro.account_assignments l WHERE l.agency_id = s.agency_id) AS links FROM kauro.sales_accounts s JOIN kauro.account_assignments c ON c.assignment_id = s.current_assignment_id WHERE s.agency_id = $1",
          [agencyId],
        );
        return { version: Number(row!.version), current: row!.seller_id, links: Number(row!.links) };
      };
      assert.deepEqual(await account(), { version: 1, current: previous.sellerId, links: 1 });
      const body = { expectedVersion: 1, sellerId: next.sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: iw.owner.userId as UserId, agencyId, sellerId: next.sellerId }) };
      const key = freshKey(label);
      const passedBefore = ctx.points.passed.length;
      await failsAt(ctx, `AssignAccount failing ${c.label}`, c.at, (conn) => routed(ctx, conn, c.steps, () => assignAccount(agencyId, key, body)));
      assert.ok(ctx.points.passed.slice(passedBefore).includes(c.done), `${c.label}: ${c.done} answered before the failure`);
      assert.deepEqual(await account(), { version: 1, current: previous.sellerId, links: 1 }, `${c.label}: the previous assignment current, nothing appended`);
      assert.equal(await journalState(key), null, `${c.label}: no journal entry`);

      const done = completed<SalesAccountView>(await assignAccount(agencyId, key, body), 200);
      assert.deepEqual([done.replayed, done.data.version, done.data.sellerId], [false, 2, next.sellerId], `${c.label}: the same key assigns once`);
      assert.deepEqual(await account(), { version: 2, current: next.sellerId, links: 2 }, `${c.label}: one new link, exactly one current assignment`);
    }
  },
);

// =====================================================================================================================================
// CLAIM_DEADLINE: AcceptAttribution of a SUBMITTED claim past its review deadline on the database clock, before the sweep ran
// =====================================================================================================================================

const CLAIM_LOCK: SqlStep = { label: "claim_lock", match: /FROM kauro\.attribution_claims WHERE claim_id = \$1 FOR UPDATE/ };
/** The nth judge of `claimId`'s review deadline in the unit (reviewDeadlineReached: CMD047 judges the named claim at :70 and again at :106). */
const DEADLINE_JUDGE = (claimId: string, nth: number): SqlStep => ({ label: "deadline_judge", match: /SELECT review_deadline_at\b.* AS reached FROM kauro\.attribution_claims/, when: (params) => params[0] === claimId, nth });
/** The lock of one share's claim (CMD047's loop over the allocation's shares, accept-attribution.ts:97). */
const SHARE_LOCK = (claimId: string): SqlStep => ({ label: "share_lock", match: /FROM kauro\.attribution_claims WHERE claim_id = \$1 FOR UPDATE/, when: (params) => params[0] === claimId });
/** The first whole millisecond not before a database instant (microseconds): the controlled clock's grain. */
const firstNotBefore = (iso: string): number => msOf(iso) + (/\.\d{3}000Z$/.test(iso) ? 0 : 1);

/**
 * AcceptAttribution on `conn`, its transaction's database clock standing at the controlled clock's instant from its claim lock on: the route
 * pauses before the claim's locking read, the step clock is put on its transaction (onServer), and the statements after it run there.
 */
async function acceptAtClock(ctx: FaultContext, conn: HarnessConnection, claimId: string, allocationId: string, key: string, what: string): Promise<Reply> {
  const pause = ctx.points.pause("db.claim_lock.before");
  return ctx.operation(what, async (op) => {
    const running = routed(ctx, conn, [CLAIM_LOCK], () => acceptClaim(claimId, allocationId, key));
    try {
      await pause.reachedBy(running);
      await op.clock.onServer(conn);
    } finally {
      pause.release();
    }
    return running;
  });
}

faultCell(
  {
    id: "CLAIM_DEADLINE",
    step: "CMD047 AcceptAttribution / EXPIRY: W allocation + shares + claims state + pools terms (one COMMIT)",
    fault: "expiry",
    expect:
      "DENY: AcceptAttribution of a SUBMITTED claim past its review deadline on the database clock, before the sweep ran, is 409 CLAIM_EXPIRED and writes nothing: the allocation stays unfrozen at its version, the claim SUBMITTED at version 1, no journal result",
  },
  async (ctx) => {
    const o = await dueOpportunity("claim-deadline-past", 60);
    ctx.deadline(msOf(o.deadline) + 1, "the claim's 2160-hour review deadline");
    const before = await allocationOf(o.allocationId);
    ctx.clock.past(msOf(o.deadline), 1_000);
    const key = freshKey("claim-deadline-past");
    const conn = await open("kauro_app_test");
    let reply: Reply;
    try {
      reply = await acceptAtClock(ctx, conn, o.claimId, o.allocationId, key, "the acceptance, its database clock a second past the review deadline");
    } finally {
      await conn.end();
    }
    assert.equal(said(reply), "409 PRECONDITION_FAILED CLAIM_EXPIRED", "a claim past its review deadline is not accepted, whether or not the sweep has lapsed it");
    assert.deepEqual(await allocationOf(o.allocationId), before, "the allocation is not frozen");
    assert.deepEqual(await claimOf(o.claimId), { state: "SUBMITTED", version: 1 }, "the claim is left for the CLAIM_WINDOWS sweep");
    assert.notEqual(await journalState(key), "COMMITTED", "no committed answer is journaled");
  },
);

faultCell(
  {
    id: "CLAIM_DEADLINE",
    step: "CMD047 AcceptAttribution / EXPIRY: W2 claim lapse against the CLAIM_WINDOWS sweep (deadline instant exactly)",
    fault: "expiry",
    expect:
      "DENY: on the database clock the review deadline instant itself is past (the lapse's own comparison, review_deadline_at <= now): AcceptAttribution whose last deadline judge stands less than the harness margin EFFECT_CLOCK_MARGIN_MS (half a second) before the deadline on its effect clock (kauro.effect_now(), which runs on with the transaction to the COMMIT judge) accepts (200, the allocation frozen at 10000 bps, the claim ACCEPTED), standing at the first millisecond not before it is 409 CLAIM_EXPIRED and writes nothing",
  },
  async (ctx) => {
    const early = await dueOpportunity("claim-deadline-early", 60);
    const exact = await dueOpportunity("claim-deadline-exact", 90);
    // the first whole millisecond not before the exact deadline (the controlled clock's grain)
    const exactFirst = msOf(exact.deadline) + (/\.\d{3}000Z$/.test(exact.deadline) ? 0 : 1);
    ctx.deadline(exactFirst, "the claim's review deadline instant");

    // the admit leg (ADV-8): the effect clock placed EFFECT_CLOCK_MARGIN_MS before the early deadline at the acceptance's last application
    // judge (the second reviewDeadlineReached of the claim, accept-attribution.ts:106). The tightest the effect clock allows: it runs on with
    // the transaction, and the statements left to the COMMIT, whose KC021 judge reads it once more, must still find the deadline ahead; under
    // one second, so a judge comparing a second early refuses this leg
    const keyEarly = freshKey("claim-deadline-early");
    const c1 = await open("kauro_app_test");
    try {
      const pause = ctx.points.pause("db.deadline_judge.before");
      const reply = await ctx.operation("the acceptance whose last judge stands just before the deadline", async () => {
        const running = routed(ctx, c1, [DEADLINE_JUDGE(early.claimId, 2)], () => acceptClaim(early.claimId, early.allocationId, keyEarly));
        try {
          await pause.reachedBy(running);
          await effectClockBefore(ctx, c1, early.deadline);
          const at = await c1.query<{ ahead: boolean; within: boolean }>(
            "SELECT kauro.effect_now() < $1::timestamptz AS ahead, kauro.effect_now() >= $1::timestamptz - make_interval(secs => $2::double precision / 1000) AS within",
            [early.deadline, EFFECT_CLOCK_MARGIN_MS],
          );
          assert.deepEqual({ ...at.rows[0] }, { ahead: true, within: true }, "the last judge stands before the deadline, by less than the harness margin");
        } finally {
          pause.release();
        }
        return running;
      });
      assert.equal(said(reply), "200", "less than the margin before the deadline the claim is still under review");
    } finally {
      await c1.end();
    }
    assert.deepEqual([(await allocationOf(early.allocationId)).frozen, (await allocationOf(early.allocationId)).shareBps, (await claimOf(early.claimId)).state], [true, 10_000, "ACCEPTED"]);

    ctx.clock.set(exactFirst);
    const before = await allocationOf(exact.allocationId);
    const keyExact = freshKey("claim-deadline-exact");
    const c2 = await open("kauro_app_test");
    try {
      const reply = await acceptAtClock(ctx, c2, exact.claimId, exact.allocationId, keyExact, "the acceptance at the deadline instant");
      assert.equal(said(reply), "409 PRECONDITION_FAILED CLAIM_EXPIRED", "at the deadline instant the claim is past its review");
    } finally {
      await c2.end();
    }
    assert.deepEqual(await allocationOf(exact.allocationId), before, "nothing frozen");
    assert.deepEqual(await claimOf(exact.claimId), { state: "SUBMITTED", version: 1 });
  },
);

// =====================================================================================================================================
// CLAIM_DEADLINE (W, ADV-1): the review deadline passing while AcceptAttribution waits on the agency's commission subject
const AGENCY_LOCK: SqlStep = { label: "agency_lock", match: /kauro\.transition_key\('kauro\.agency_commissions'/ };

faultCell(
  {
    id: "CLAIM_DEADLINE",
    step: "CMD047 AcceptAttribution / EXPIRY: W allocation + shares + claims state + pools terms (one COMMIT), the deadline passing during a lock wait",
    fault: "race",
    expect:
      "RACE: AcceptAttribution whose database clock stands before the claim's review deadline when it starts and that waits on the agency's commission subject (held as TerminateSeller or the COMMISSIONS consumer holds it) until the deadline has passed is 409 CLAIM_EXPIRED and writes nothing: the deadline is judged at the instant of the statement after the wait (kauro.effect_now()) and again at COMMIT, never at the unit's start",
  },
  async (ctx) => {
    const o = await dueOpportunity("claim-deadline-waited", 60);
    const before = await allocationOf(o.allocationId);
    const holder = await open("kauro_app_test");
    const waiter = await open("kauro_app_test");
    const key = freshKey("claim-deadline-waited");
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.agency_commissions', $1))", [o.agencyId]);
      const pause = ctx.points.pause("db.agency_lock.before");
      let instant = "";
      const waiting = await ctx.mustWait(iw.h.oracle, { waiter, holder: connectionPid(holder) }, async (conn) => {
          const running = routed(ctx, conn, [AGENCY_LOCK], () => acceptClaim(o.claimId, o.allocationId, key));
          try {
            await pause.reachedBy(running);
            // the acceptance's effect clock the harness margin before the deadline at its agency lock (ADV-8: no literal margin)
            instant = await effectClockBefore(ctx, conn, o.deadline);
          } finally {
            pause.release();
          }
          return running;
        }, "the acceptance while the agency's commission subject is held");
      // the deadline passes while the acceptance waits: its effect clock, measured on the database, runs past it (never a fixed sleep)
      await crossedWhileWaiting(waiter, holder, instant, o.deadline, "the acceptance waiting on the agency's commission subject");
      await holder.query("COMMIT");
      assert.equal(said(valueOf(await waiting.pending, "the acceptance")), "409 PRECONDITION_FAILED CLAIM_EXPIRED", "a deadline crossed during the wait refuses the acceptance");
    } finally {
      await holder.end();
      await waiter.end();
    }
    assert.deepEqual(await allocationOf(o.allocationId), before, "the allocation is not frozen");
    assert.deepEqual(await claimOf(o.claimId), { state: "SUBMITTED", version: 1 }, "the claim is left for the CLAIM_WINDOWS sweep");
    assert.notEqual(await journalState(key), "COMMITTED");
  },
);

// =====================================================================================================================================
// CLAIM_DEADLINE (ADV-7): the review deadline passing after every statement judged it, refused only by the COMMIT judge
// (0045 attribution_claims_accepted_in_window, KC021, mapped to 409 PRECONDITION_FAILED CLAIM_EXPIRED by sqlstate.ts)
// =====================================================================================================================================

faultCell(
  {
    id: "CLAIM_DEADLINE",
    step: "CMD047 AcceptAttribution / EXPIRY: W allocation + shares + claims state + pools terms (one COMMIT), the deadline passing between the writes and the COMMIT",
    fault: "expiry",
    expect:
      "DENY: AcceptAttribution whose statements all judged the claim's review deadline ahead and wrote the claim ACCEPTED, and whose database clock passes the deadline while it stands at its COMMIT, is 409 PRECONDITION_FAILED CLAIM_EXPIRED (the COMMIT judge KC021) and commits nothing: the allocation unfrozen at its version, the claim SUBMITTED at version 1, no committed journal answer",
  },
  async (ctx) => {
    const o = await dueOpportunity("claim-deadline-commit", 60);
    ctx.deadline(firstNotBefore(o.deadline), "the claim's review deadline");
    const before = await allocationOf(o.allocationId);
    const key = freshKey("claim-deadline-commit");
    const conn = await open("kauro_app_test");
    let reply: Reply;
    try {
      const pause = ctx.points.pause("uow.before-commit");
      reply = await ctx.operation("the acceptance, its database clock moved past the review deadline at its COMMIT", async (op) => {
        const running = routed(ctx, conn, [], () => acceptClaim(o.claimId, o.allocationId, key));
        try {
          await pause.reachedBy(running);
          const written = await conn.query<{ state: string; ahead: boolean }>("SELECT state, kauro.effect_now() < review_deadline_at AS ahead FROM kauro.attribution_claims WHERE claim_id = $1", [o.claimId]);
          assert.deepEqual({ ...written.rows[0] }, { state: "ACCEPTED", ahead: true }, "the acceptance wrote the claim ACCEPTED with its review deadline still ahead");
          ctx.clock.past(o.deadline);
          await op.clock.onServer(conn);
          const crossed = await conn.query<{ crossed: boolean }>("SELECT review_deadline_at <= kauro.effect_now() AS crossed FROM kauro.attribution_claims WHERE claim_id = $1", [o.claimId]);
          assert.equal(crossed.rows[0]!.crossed, true, "the database clock crossed the review deadline before the COMMIT");
        } finally {
          pause.release();
        }
        return running;
      });
    } finally {
      await conn.end();
    }
    assert.equal(said(reply), "409 PRECONDITION_FAILED CLAIM_EXPIRED", "an acceptance whose review deadline passed before its COMMIT commits nothing (KC021)");
    assert.deepEqual(await allocationOf(o.allocationId), before, "the allocation is not frozen");
    assert.deepEqual(await claimOf(o.claimId), { state: "SUBMITTED", version: 1 }, "the claim is left SUBMITTED for the CLAIM_WINDOWS sweep");
    assert.notEqual(await journalState(key), "COMMITTED", "no committed answer is journaled");
  },
);

faultCell(
  {
    id: "CLAIM_DEADLINE",
    step: "CMD047 AcceptAttribution / EXPIRY: W allocation + shares + claims state + pools terms (one COMMIT), a share's deadline passing while the unit waits on a later share's claim",
    fault: "race",
    expect:
      "RACE: a 4000/3000/3000 split whose acceptance judged share X's review deadline ahead when it locked X's claim, then waits on share Y's claim (held by another session) until X's deadline has passed, is 409 PRECONDITION_FAILED CLAIM_EXPIRED and writes nothing: the allocation unfrozen at its version, the three claims SUBMITTED at version 1, no committed journal answer (the last application judge reads the named claim only; X is refused at COMMIT, KC021)",
  },
  async (ctx) => {
    const label = "claim-deadline-split";
    const a = await agentOf(iw, `${label}-agency`);
    const named = await seller(iw, `${label}-named`);
    // the shares are locked in seller order (allocation_shares ORDER BY seller_id): X, whose deadline is near, before Y
    const ordered = [await seller(iw, `${label}-a`), await seller(iw, `${label}-b`)].sort((p, q) => (p.sellerId < q.sellerId ? -1 : 1));
    const [sx, sy] = ordered;
    if (sx === undefined || sy === undefined) throw new Error("two sellers were recorded");
    const prospect = await recordProspect(iw.h, { by: named, domain: `${label}.example` });
    const m = await claimDueIn(named, prospect.prospectId, HOUR_S);
    const x = await claimDueIn(sx, prospect.prospectId, 60);
    const y = await claimDueIn(sy, prospect.prospectId, HOUR_S);
    const claimIds = [m.claimId, x.claimId, y.claimId];
    const allocationId = await prepareAllocation(iw.h, {
      ownerUserId: iw.owner.userId,
      agencyId: a.s.agency.agencyId,
      prospectId: prospect.prospectId,
      shares: [
        { seller: named, claimId: m.claimId, shareBps: 4_000 },
        { seller: sx, claimId: x.claimId, shareBps: 3_000 },
        { seller: sy, claimId: y.claimId, shareBps: 3_000 },
      ],
    });
    ctx.deadline(firstNotBefore(x.deadline), "share X's review deadline");
    const before = await allocationOf(allocationId);
    const holder = await open("kauro_app_test");
    const waiter = await open("kauro_app_test");
    const key = freshKey(label);
    try {
      await holder.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await holder.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [iw.owner.userId]);
      const held = await holder.query("SELECT claim_id FROM kauro.attribution_claims WHERE claim_id = $1 FOR UPDATE", [y.claimId]);
      assert.equal(held.rowCount, 1, "another session holds share Y's claim");
      const pause = ctx.points.pause("db.share_lock.before");
      const waiting = await ctx.mustWait(iw.h.oracle, { waiter, holder: connectionPid(holder) }, async (conn) => {
          const running = routed(ctx, conn, [SHARE_LOCK(y.claimId)], () => acceptClaim(m.claimId, allocationId, key));
          try {
            await pause.reachedBy(running);
            // X locked and judged (its deadline ahead), Y's lock next: X's deadline passes here, the named claim's stays ahead
            const judged = await conn.query<{ x_ahead: boolean }>("SELECT kauro.effect_now() < review_deadline_at AS x_ahead FROM kauro.attribution_claims WHERE claim_id = $1", [x.claimId]);
            assert.equal(judged.rows[0]!.x_ahead, true, "share X's deadline was ahead when the acceptance judged it");
            ctx.clock.past(x.deadline);
            await ctx.clock.onServer(conn);
            const now = await conn.query<{ x_passed: boolean; m_ahead: boolean }>(
              "SELECT (SELECT review_deadline_at FROM kauro.attribution_claims WHERE claim_id = $1) <= kauro.effect_now() AS x_passed, (SELECT review_deadline_at FROM kauro.attribution_claims WHERE claim_id = $2) > kauro.effect_now() AS m_ahead",
              [x.claimId, m.claimId],
            );
            assert.deepEqual({ ...now.rows[0] }, { x_passed: true, m_ahead: true }, "X's deadline passed, the named claim's still ahead, as the acceptance takes Y's lock");
          } finally {
            pause.release();
          }
          return running;
        }, "the split's acceptance while another session holds share Y's claim");
      await holder.query("COMMIT");
      assert.equal(said(valueOf(await waiting.pending, "the acceptance")), "409 PRECONDITION_FAILED CLAIM_EXPIRED", "share X's deadline passed while the acceptance waited on share Y's claim: refused at COMMIT");
    } finally {
      await holder.end();
      await waiter.end();
    }
    assert.deepEqual(await allocationOf(allocationId), before, "the allocation is not frozen");
    assert.deepEqual(await claimsOf(claimIds), [["SUBMITTED", 1], ["SUBMITTED", 1], ["SUBMITTED", 1]], "no share's claim ACCEPTED");
    assert.notEqual(await journalState(key), "COMMITTED", "no committed answer is journaled");
  },
);

// =====================================================================================================================================
// CLAIM_LAPSE_ACCEPT: AcceptAttribution racing the CLAIM_WINDOWS lapse of the same claim at its deadline, in both orders
// =====================================================================================================================================

const LAPSE_UPDATE = (claimId: string): SqlStep => ({ label: "lapse_update", match: /UPDATE kauro\.attribution_claims AS c SET/, when: (params) => params[0] === claimId });

interface LapseOutcome {
  readonly accept: string;
  /** Lapse first: an acceptance of the lapsed claim naming its current version, after the race. */
  readonly acceptCurrent?: string;
  readonly item: string | undefined;
  readonly claim: ClaimRow;
  readonly frozen: boolean;
  readonly claimId: string;
  readonly allocationId: string;
}
type Itemized = { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> };
const sweepOf = (ctx: FaultContext, claimId: string, at?: string): Actor => ({ name: "the CLAIM_WINDOWS pass", login: "kauro_commission_test", holdAt: "db.lapse_update.after", run: (conn) => sweepOn(ctx, conn, "CLAIM_WINDOWS", [LAPSE_UPDATE(claimId)], at) });
const acceptOf = (ctx: FaultContext, label: string, o: { readonly claimId: string; readonly allocationId: string }): Actor => ({
  name: "AcceptAttribution",
  login: "kauro_app_test",
  holdAt: "uow.before-commit",
  run: (conn) => routed(ctx, conn, [], () => acceptClaim(o.claimId, o.allocationId, freshKey(label))),
});

/** Lapse first: the claim's deadline passed a second ago, the sweep holds the claim right after writing it EXPIRED and the acceptance is observed waiting on the claims lock. */
async function lapseFirst(ctx: FaultContext, label: string): Promise<LapseOutcome> {
  const lapsed = await dueOpportunity(`${label}-lapse-first`, -1);
  const one = await contend(ctx, sweepOf(ctx, lapsed.claimId), acceptOf(ctx, label, lapsed), "the lapse holds the claim, the acceptance waits");
  const current = await claimOf(lapsed.claimId);
  return {
    accept: said(valueOf(one.waiter as PromiseSettledResult<Reply>, "the acceptance")),
    acceptCurrent: said(await acceptClaim(lapsed.claimId, lapsed.allocationId, freshKey(`${label}-current`), current.version)),
    item: itemOf(mustHaveSettled(one.holder, "the CLAIM_WINDOWS pass") as Itemized, lapsed.claimId),
    claim: current,
    frozen: (await allocationOf(lapsed.allocationId)).frozen,
    claimId: lapsed.claimId,
    allocationId: lapsed.allocationId,
  };
}
/** Acceptance first: the claim is due 30 s from now, the acceptance (now, inside the review window) holds at its COMMIT and the sweep, standing a second past the deadline, is observed waiting on the claim. */
async function acceptFirst(ctx: FaultContext, label: string): Promise<LapseOutcome> {
  const due = await dueOpportunity(`${label}-accept-first`, 30);
  const standing = new Date(msOf(due.deadline) + 1_000).toISOString();
  const two = await contend(ctx, acceptOf(ctx, label, due), sweepOf(ctx, due.claimId, standing), "the acceptance holds the claim, the lapse waits");
  return {
    accept: said(valueOf(two.holder as PromiseSettledResult<Reply>, "the acceptance")),
    item: itemOf(mustHaveSettled(two.waiter, "the CLAIM_WINDOWS pass") as Itemized, due.claimId),
    claim: await claimOf(due.claimId),
    frozen: (await allocationOf(due.allocationId)).frozen,
    claimId: due.claimId,
    allocationId: due.allocationId,
  };
}

faultCell(
  {
    id: "CLAIM_LAPSE_ACCEPT",
    step: "CMD047 AcceptAttribution / RACE: W2 claim lapse against the CLAIM_WINDOWS sweep",
    fault: "race",
    expect:
      "RACE: AcceptAttribution racing the CLAIM_WINDOWS lapse of the same claim at its deadline: one wins in both orders with the lock wait observed; the acceptance that waited on the lapse is refused (its claim moved on) and accepting the lapsed claim is 409 CLAIM_EXPIRED, writing no allocation (the claim EXPIRED, the allocation unfrozen); an acceptance that committed inside the review window keeps the claim ACCEPTED with its allocation frozen",
  },
  async (ctx) => {
    const one = await lapseFirst(ctx, "lapse-accept-cmd047");
    assert.deepEqual([one.claim.state, one.frozen], ["EXPIRED", false], "lapse first: the claim EXPIRED, no allocation frozen");
    assert.equal(one.accept, "409 STALE_VERSION -", "lapse first: the acceptance that waited on the lapse is refused (the claim it read moved on: expectedVersion is checked first)");
    assert.equal(one.acceptCurrent, "409 PRECONDITION_FAILED CLAIM_EXPIRED", "lapse first: accepting the lapsed claim at its current version is CLAIM_EXPIRED");
    assert.deepEqual([(await claimOf(one.claimId)).state, (await allocationOf(one.allocationId)).frozen], ["EXPIRED", false], "lapse first: still no allocation");
    const two = await acceptFirst(ctx, "lapse-accept-cmd047");
    assert.deepEqual([two.accept, two.claim.state, two.frozen], ["200", "ACCEPTED", true], "acceptance first: the claim ACCEPTED under its frozen allocation");
  },
);

faultCell(
  {
    id: "CLAIM_LAPSE_ACCEPT",
    step: "Sweep CLAIM_WINDOWS / RACE: W1 claim EXPIRED (ordinary submitted or accepted claim, no tail)",
    fault: "race",
    expect:
      "RACE: the CLAIM_WINDOWS lapse racing AcceptAttribution of the same claim at its deadline, in both orders with the lock wait observed: the lapse that committed first leaves the claim EXPIRED (item EXPIRED); a lapse that waited on an acceptance committed inside the review window finds the claim ACCEPTED and no longer due and settles it without failing (item SETTLED, no failure handed to the background sink), the claim staying ACCEPTED",
  },
  async (ctx) => {
    const one = await lapseFirst(ctx, "lapse-accept-sweep");
    assert.deepEqual([one.item, one.claim.state], ["EXPIRED", "EXPIRED"], "lapse first: EXPIRED once");
    const two = await acceptFirst(ctx, "lapse-accept-sweep");
    assert.deepEqual([two.item, two.claim.state], ["SETTLED", "ACCEPTED"], "acceptance first: the waiting lapse settles the accepted claim, never fails on it");
  },
);

// =====================================================================================================================================
// AGREEMENT_EXP (CMD046): the seller's agreement version superseded while ClaimProspect runs
// =====================================================================================================================================

/** The owner moves the ACTIVE seller onto a new signed agreement version (its reviewed classification), on `conn`; `commit: false` leaves it open. */
async function supersedeAgreement(conn: HarnessConnection, s: RecordedSeller, options: { readonly commit: boolean }): Promise<string> {
  const owner = iw.owner.userId;
  const reviewId = ids.next();
  const agreementId = ids.next();
  const version = `SA-${agreementId.slice(-8)}`;
  await conn.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await conn.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [owner]);
  await conn.query(
    "INSERT INTO kauro.seller_legal_reviews (review_id, seller_id, classification, outcome, substance_hash, reviewer_label, evidence_hash, reviewed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'INDEPENDENT_COLLABORATION', 'CONFIRMED', $3, 'Reviewing counsel', $4, now(), $5, now())",
    [reviewId, s.sellerId, sha(`substance-${reviewId}`), sha(`review-${reviewId}`), owner],
  );
  await conn.query(
    `INSERT INTO kauro.seller_agreements (agreement_id, seller_id, agreement_version, classification, legal_review_id, starts_at, first_bps, repeat_bps, recurring_months, offset_terms,
       retainer_cents_per_month, compensation_policy_version, signed_terms_hash, prepared_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'INDEPENDENT_COLLABORATION', $4, now(), 1000, 400, 12, 'NONE', 0, 'R2-INITIAL', $5, $6, now(), now())`,
    [agreementId, s.sellerId, version, reviewId, sha(`terms-${agreementId}`), owner],
  );
  await conn.query("UPDATE kauro.seller_agreements SET signed_at = now(), signature_evidence_hash = $2, version = 2 WHERE agreement_id = $1", [agreementId, sha(`signature-${agreementId}`)]);
  await conn.query("UPDATE kauro.sellers SET agreement_id = $2, version = version + 1 WHERE seller_id = $1", [s.sellerId, agreementId]);
  if (options.commit) await conn.query("COMMIT");
  return version;
}

faultCell(
  {
    id: "AGREEMENT_EXP",
    step: "CMD046 ClaimProspect / EXPIRY: W claim + deadline + conflict review (one COMMIT)",
    fault: "race",
    expect:
      "RACE: a new agreement version of the seller put in force while ClaimProspect runs, in both orders with the lock wait observed: a claim holding its locks commits bound to the version in force at them (the supersession waits for it and lands after); a claim arriving while the supersession is uncommitted waits for it and, naming the superseded version, is 409 AGREEMENT_VERSION_MISMATCH with no claim written",
  },
  async (ctx) => {
    // the claim first (held at its COMMIT): the supersession must wait for it
    {
      const s = await seller(iw, "agreement-exp-claim-first");
      const prospect = await recordProspect(iw.h, { by: s, domain: "agreement-exp-claim-first.example" });
      const evidenceHash = await recordClaimEvidence(iw.h, s, prospect.prospectId);
      const hc = await open("kauro_app_test");
      const wc = await open("kauro_app_test");
      const pause = ctx.points.pause("uow.before-commit");
      try {
        const holding = ctx.operation("ClaimProspect (holder)", () => routed(ctx, hc, [], () => claimProspect(s.person, prospect.prospectId, freshKey("agreement-exp-1"), { evidenceHash, agreementVersion: s.agreementVersion })));
        await pause.reachedBy(holding);
        const waiting = await afterward(() => ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (conn) => supersedeAgreement(conn, s, { commit: true }), "the agreement supersession while the claim holds its locks"), () => pause.release());
        const claim = completed<{ state: string; agreementVersion?: string }>(await holding, 201);
        assert.equal(claim.data.state, "SUBMITTED");
        await waiting.pending;
        const [row] = await oracleRows<{ agreement_version: string }>(iw, "SELECT agreement_version FROM kauro.attribution_claims WHERE prospect_id = $1 AND seller_id = $2", [prospect.prospectId, s.sellerId]);
        assert.equal(row!.agreement_version, s.agreementVersion, "the claim is bound to the version in force at its locks");
      } finally {
        await hc.end();
        await wc.end();
      }
    }
    // the supersession first (uncommitted): the claim must wait for it, then names a superseded version
    {
      const s = await seller(iw, "agreement-exp-switch-first");
      const prospect = await recordProspect(iw.h, { by: s, domain: "agreement-exp-switch-first.example" });
      const evidenceHash = await recordClaimEvidence(iw.h, s, prospect.prospectId);
      const sc = await open("kauro_app_test");
      const wc = await open("kauro_app_test");
      try {
        await supersedeAgreement(sc, s, { commit: false });
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(sc) }, (conn) => routed(ctx, conn, [], () => claimProspect(s.person, prospect.prospectId, freshKey("agreement-exp-2"), { evidenceHash, agreementVersion: s.agreementVersion })), "ClaimProspect while the supersession is uncommitted");
        await sc.query("COMMIT");
        assert.equal(said(valueOf(await waiting.pending, "ClaimProspect")), "409 PRECONDITION_FAILED AGREEMENT_VERSION_MISMATCH", "the claim names a superseded version");
      } finally {
        await sc.end();
        await wc.end();
      }
      assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.attribution_claims WHERE prospect_id = $1", [prospect.prospectId]), [{ n: 0 }], "no claim written");
    }
  },
);

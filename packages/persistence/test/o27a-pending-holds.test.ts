// Migration 0135 (Order 27A; CP-01.11 CONDITIONAL, activation OFF): the database half of the pending-payment hold on a real PostgreSQL 17.
//   1. Activation OFF: no runtime role can write a hold (no grant); row security is enabled and forced.
//   2. Uniqueness: one hold per quote and one per sealed set, ever, whatever the earlier hold's state.
//   3. The proof is the quote's exact USD total, the sealed set is the quote's own sealed revision at its recorded seal, the ceiling is
//      576 hours after the seal and the end never passes it; a hold is never a payment and never authorizes execution.
//   4. The third hold after two ended unpaid in the rolling 90 days names the owner's review, or it is refused.
//   5. A hold ends once (ACTIVE -> PAID, or ENDED_UNPAID only at its effective end), at the server's clock; nothing else changes; never deleted.
//   6. Tenant isolation: an agency reads only its own holds; the corporate owner reads all; an unbound session reads none.
// The migration range 0135-0149 is reserved for O27A on top of 0120-0134 (O22); on this branch alone the runner's contiguity rule is met by
// copying 0001-0096 and this file renumbered 0097 into a temporary directory (the integrator assembles the reserved ranges).
// The superuser connection is the oracle and the only writer (the activation is OFF), including the planted past holds of case 4.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { fedAchCalendar, holdDates } from "@kauro/domain";
import { MIGRATIONS_DIR } from "../src/index.js";
import { agencyWith, closeWorld, openWorld, quoteOf, subjectOf, type Agency, type World } from "./b10-commission-support.js";
import { ids, sha, sqlState } from "./support.js";

const SUFFIX = "_o27a_pending_payment_holds.sql";
let w: World;
let dir: string;
let A: Agency;
let B: Agency;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kauro-0135-"));
  // the directory as written (listMigrations refuses the reserved-range gap on this branch alone): every file below this one, then this
  // one, renumbered by position in the copy (content unchanged), so the test holds before and after the integrator renumbers it
  const all = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const mine = all.find((f) => f.endsWith(SUFFIX));
  assert.ok(mine !== undefined, "the O27A holds migration is in the migrations directory");
  const chain = [...all.filter((f) => f < mine), mine];
  assert.ok(chain.length >= 97, "main's 0001-0096 come first");
  chain.forEach((f, i) => copyFileSync(join(MIGRATIONS_DIR, f), join(dir, `${String(i + 1).padStart(4, "0")}${f.slice(4)}`)));
  w = await openWorld("o27a-holds", { migrationsDir: dir });
  A = await agencyWith(w, "Holds Alpha");
  B = await agencyWith(w, "Holds Bravo");
});

after(async () => {
  if (w !== undefined) await closeWorld(w);
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

interface Subject {
  readonly quoteId: string;
  readonly projectId: string;
  readonly revisionId: string;
  /** The recorded seal as PostgreSQL prints it (microseconds kept: a JS Date would round them away). */
  readonly sealedAt: string;
  readonly sealedMs: number;
  readonly ceilingAt: string;
  readonly totalCents: number;
}

async function quotedSubject(ag: Agency, seed: string, existing?: Awaited<ReturnType<typeof subjectOf>>): Promise<Subject> {
  const subject = existing ?? (await subjectOf(w, ag, seed));
  const quote = await quoteOf(w, ag, subject);
  const r = await w.h.oracle.query<{ sealed: string; ms: string; ceiling: string }>(
    "SELECT sealed_at::text AS sealed, (extract(epoch FROM sealed_at) * 1000)::bigint::text AS ms, (sealed_at + interval '576 hours')::text AS ceiling FROM kauro.dataset_revisions WHERE revision_id = $1",
    [subject.revisionId],
  );
  const row = r.rows[0]!;
  return { quoteId: quote.quoteId, projectId: subject.projectId, revisionId: subject.revisionId, sealedAt: row.sealed, sealedMs: Number(row.ms), ceilingAt: row.ceiling, totalCents: quote.totalCents };
}

async function holdRow(ag: Agency, s: Subject, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const now = (await w.h.oracle.query<{ now: Date }>("SELECT kauro.server_now() AS now")).rows[0]!.now.toISOString();
  const dates = holdDates({ acceptedAt: now, sealedAt: new Date(s.sealedMs).toISOString(), extensionEndsAt: null, calendar: fedAchCalendar(2025, 2030) });
  assert.ok(dates !== null && dates.whichApplied === "BUSINESS_DAYS", "a recent seal: the five banking days end first");
  return {
    hold_id: ids.next(),
    agency_id: ag.agencyId,
    quote_id: s.quoteId,
    project_id: s.projectId,
    sealed_revision_id: s.revisionId,
    sealed_at: s.sealedAt,
    route: "ACH",
    proof_currency: "USD",
    proof_amount_cents: s.totalCents,
    proof_reference: "KAURO-TEST-REF",
    proof_sent_at: new Date(Date.parse(now) - 3_600_000).toISOString(),
    proof_evidence_hash: sha(`proof-${s.quoteId}`),
    presented_by_user_id: ag.ownerUserId,
    step_up_proof_ref: ids.next(),
    calendar_version: "FEDACH-RULE-1",
    business_days_end_at: dates.businessDaysEndAt,
    ceiling_at: s.ceilingAt,
    effective_end_at: dates.effectiveEndAt,
    ...over,
  };
}

async function insert(c: Client, row: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(row);
  await c.query(`INSERT INTO kauro.pending_payment_holds (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => row[k]));
}

async function refused(p: Promise<unknown>, state: string, what: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.equal(sqlState(e), state, `${what}: ${String(e)}`);
    return true;
  });
}

/** One transaction of kauro_app with the agency (or none) and the person bound. */
async function bound<T>(agencyId: string | null, userId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = w.app;
  await c.query("BEGIN");
  try {
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agencyId ?? "", userId ?? ""]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

let held: Subject;
let heldSubject: Awaited<ReturnType<typeof subjectOf>>;

test("0135: activation OFF — no runtime role holds a write grant; row security is enabled and forced", async () => {
  const rls = await w.h.oracle.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'kauro.pending_payment_holds'::regclass");
  assert.deepEqual(rls.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  for (const role of ["kauro_app", "kauro_control", "kauro_assurance", "kauro_validator", "kauro_ingress", "kauro_payment", "kauro_commission"]) {
    for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      const r = await w.h.oracle.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'kauro.pending_payment_holds', $2) AS ok", [role, priv]);
      assert.equal(r.rows[0]!.ok, false, `${role} ${priv}`);
    }
  }
  heldSubject = await subjectOf(w, A, "o27a-hold-a1");
  held = await quotedSubject(A, "", heldSubject);
  const row = await holdRow(A, held);
  await refused(bound(A.agencyId, A.ownerUserId, (c) => insert(c, row)), "42501", "the agency's owner cannot create a hold while the activation is off");
});

test("0135: a valid hold is accepted at the server's clock, ACTIVE, never a payment; one per quote and one per sealed set, ever", async () => {
  await insert(w.h.oracle, await holdRow(A, held));
  const r = await w.h.oracle.query("SELECT state, is_payment, authorizes_execution, accepted_at = created_at AS stamped, ended_at FROM kauro.pending_payment_holds WHERE quote_id = $1", [held.quoteId]);
  assert.deepEqual(r.rows, [{ state: "ACTIVE", is_payment: false, authorizes_execution: false, stamped: true, ended_at: null }]);
  await refused(insert(w.h.oracle, await holdRow(A, held)), "23505", "a second hold of the same quote");
  // a new quote over the same sealed set does not buy a second hold (the unique key, not the trigger): the first quote expires, a new one
  // prices the same sealed revision
  // (fixture: the expiry is planted by the oracle with triggers off; the quote's lifecycle is not what this test proves)
  await w.h.oracle.query("SET session_replication_role = replica");
  try {
    await w.h.oracle.query("UPDATE kauro.quotes SET state = 'EXPIRED', version = version + 1 WHERE quote_id = $1", [held.quoteId]);
  } finally {
    await w.h.oracle.query("SET session_replication_role = origin");
  }
  const sameSet = await quotedSubject(A, "", heldSubject);
  assert.notEqual(sameSet.quoteId, held.quoteId);
  assert.equal(sameSet.revisionId, held.revisionId);
  await refused(insert(w.h.oracle, await holdRow(A, sameSet)), "23505", "another quote over the same sealed set");
  // a quote of another revision cannot name this sealed set
  const other = await quotedSubject(A, "o27a-hold-a2");
  await refused(insert(w.h.oracle, await holdRow(A, other, { sealed_revision_id: held.revisionId, sealed_at: held.sealedAt, ceiling_at: held.ceilingAt })), "23514", "a quote of another revision naming this sealed set");
  const count = await w.h.oracle.query("SELECT 1 FROM kauro.pending_payment_holds WHERE agency_id = $1 AND sealed_revision_id = $2", [A.agencyId, held.revisionId]);
  assert.equal(count.rowCount, 1);
});

test("0135: the proof is the quote's exact USD total; the sealed set is the quote's own at its seal; the dates respect the 576-hour ceiling", async () => {
  const s = await quotedSubject(A, "o27a-hold-a3");
  await refused(insert(w.h.oracle, await holdRow(A, s, { proof_amount_cents: s.totalCents - 1 })), "23514", "one cent short");
  await refused(insert(w.h.oracle, await holdRow(A, s, { proof_amount_cents: s.totalCents + 1 })), "23514", "one cent over");
  await refused(insert(w.h.oracle, await holdRow(A, s, { proof_currency: "COP" })), "23514", "not USD");
  await refused(insert(w.h.oracle, await holdRow(A, s, { route: "WIRE" })), "23514", "not ACH");
  await refused(insert(w.h.oracle, await holdRow(A, s, { sealed_at: new Date(s.sealedMs - 1000).toISOString(), ceiling_at: new Date(s.sealedMs - 1000 + 576 * 3_600_000).toISOString() })), "23514", "another seal instant");
  await refused(insert(w.h.oracle, await holdRow(A, s, { ceiling_at: new Date(s.sealedMs + 577 * 3_600_000).toISOString() })), "23514", "a ceiling beyond 576 hours");
  await refused(insert(w.h.oracle, await holdRow(A, s, { effective_end_at: new Date(s.sealedMs + 577 * 3_600_000).toISOString() })), "23514", "an end beyond the ceiling");
  await refused(insert(w.h.oracle, await holdRow(A, s, { is_payment: true })), "23514", "a hold is never a payment");
  await refused(insert(w.h.oracle, await holdRow(A, s, { authorizes_execution: true })), "23514", "a hold never authorizes execution");
  await refused(insert(w.h.oracle, await holdRow(A, s, { proof_sent_at: new Date(Date.now() + 86_400_000).toISOString() })), "23514", "a transfer not sent yet");
  // B's quote under A's agency: the composite key refuses it
  const other = await quotedSubject(B, "o27a-hold-b0");
  await refused(insert(w.h.oracle, await holdRow(A, other)), "23503", "another agency's quote");
});

test("0135 abuse: after two holds ended unpaid in the rolling 90 days the next hold names the owner's review; older ones do not count", async () => {
  const plant = async (endedDaysAgo: number): Promise<void> => {
    const now = Date.now();
    await w.h.oracle.query("SET session_replication_role = replica");
    try {
      await insert(w.h.oracle, {
        hold_id: ids.next(), agency_id: B.agencyId, quote_id: ids.next(), project_id: ids.next(), sealed_revision_id: ids.next(),
        sealed_at: new Date(now - 60 * 86_400_000).toISOString(), route: "ACH", proof_currency: "USD", proof_amount_cents: 1000, proof_reference: "KAURO-PAST",
        proof_sent_at: new Date(now - 59 * 86_400_000).toISOString(), proof_evidence_hash: sha(`past-${endedDaysAgo}-${now}`), presented_by_user_id: B.ownerUserId,
        step_up_proof_ref: ids.next(), accepted_at: new Date(now - 59 * 86_400_000).toISOString(), calendar_version: "FEDACH-RULE-1",
        business_days_end_at: new Date(now - 52 * 86_400_000).toISOString(), ceiling_at: new Date(now - 60 * 86_400_000 + 576 * 3_600_000).toISOString(),
        effective_end_at: new Date(now - 52 * 86_400_000).toISOString(), state: "ENDED_UNPAID", ended_at: new Date(now - endedDaysAgo * 86_400_000).toISOString(),
        created_at: new Date(now - 59 * 86_400_000).toISOString(), updated_at: new Date(now - endedDaysAgo * 86_400_000).toISOString(),
      });
    } finally {
      await w.h.oracle.query("SET session_replication_role = origin");
    }
  };
  await plant(120);
  await plant(40);
  const first = await quotedSubject(B, "o27a-hold-b1");
  await insert(w.h.oracle, await holdRow(B, first)); // one in the window: granted
  await plant(10);
  const third = await quotedSubject(B, "o27a-hold-b2");
  await refused(insert(w.h.oracle, await holdRow(B, third)), "23514", "two ended unpaid in 90 days: the owner must review");
  await insert(w.h.oracle, await holdRow(B, third, { owner_review_ref: ids.next() }));
  // the rule is per organization: A has none ended unpaid
  const a = await quotedSubject(A, "o27a-hold-a4");
  await insert(w.h.oracle, await holdRow(A, a));
});

test("0135: a hold ends once at the server's clock — PAID any time, ENDED_UNPAID only at its end; nothing else changes; never deleted", async () => {
  const q = held.quoteId;
  await refused(w.h.oracle.query("UPDATE kauro.pending_payment_holds SET state = 'ENDED_UNPAID' WHERE quote_id = $1", [q]), "23514", "before the effective end");
  await refused(w.h.oracle.query("UPDATE kauro.pending_payment_holds SET proof_amount_cents = proof_amount_cents + 1 WHERE quote_id = $1", [q]), "23514", "only the state changes");
  await refused(w.h.oracle.query("UPDATE kauro.pending_payment_holds SET effective_end_at = effective_end_at + interval '1 day', state = 'PAID' WHERE quote_id = $1", [q]), "23514", "no renewal");
  await w.h.oracle.query("UPDATE kauro.pending_payment_holds SET state = 'PAID' WHERE quote_id = $1", [q]);
  const r = await w.h.oracle.query("SELECT state, version, ended_at IS NOT NULL AS ended FROM kauro.pending_payment_holds WHERE quote_id = $1", [q]);
  assert.deepEqual(r.rows, [{ state: "PAID", version: "2", ended: true }]);
  await refused(w.h.oracle.query("UPDATE kauro.pending_payment_holds SET state = 'ENDED_UNPAID' WHERE quote_id = $1", [q]), "23514", "a hold ends once");
  await refused(w.h.oracle.query("DELETE FROM kauro.pending_payment_holds WHERE quote_id = $1", [q]), "KA004", "never deleted");
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.pending_payment_holds WHERE quote_id = $1", [q])).rowCount, 1);
});

test("0135 isolation: an agency reads only its own holds, the corporate owner reads all, an unbound session reads none", async () => {
  const total = Number((await w.h.oracle.query<{ n: string }>("SELECT count(*) AS n FROM kauro.pending_payment_holds")).rows[0]!.n);
  const ofA = Number((await w.h.oracle.query<{ n: string }>("SELECT count(*) AS n FROM kauro.pending_payment_holds WHERE agency_id = $1", [A.agencyId])).rows[0]!.n);
  assert.ok(ofA >= 2 && total > ofA);
  const seenByA = await bound(A.agencyId, A.ownerUserId, async (c) => (await c.query<{ agency_id: string }>("SELECT agency_id FROM kauro.pending_payment_holds")).rows);
  assert.equal(seenByA.length, ofA);
  assert.ok(seenByA.every((x) => x.agency_id === A.agencyId), "never another agency's hold");
  const seenByB = await bound(B.agencyId, B.ownerUserId, async (c) => (await c.query<{ agency_id: string }>("SELECT agency_id FROM kauro.pending_payment_holds")).rows);
  assert.ok(seenByB.length > 0 && seenByB.every((x) => x.agency_id === B.agencyId));
  // A's owner naming B's agency id in the query still reads nothing of B
  const probe = await bound(A.agencyId, A.ownerUserId, async (c) => (await c.query("SELECT 1 FROM kauro.pending_payment_holds WHERE agency_id = $1", [B.agencyId])).rowCount);
  assert.equal(probe, 0);
  const owner = await bound(null, w.kora, async (c) => (await c.query("SELECT 1 FROM kauro.pending_payment_holds")).rowCount);
  assert.equal(owner, total);
  const nobody = await bound(null, null, async (c) => (await c.query("SELECT 1 FROM kauro.pending_payment_holds")).rowCount);
  assert.equal(nobody, 0);
});

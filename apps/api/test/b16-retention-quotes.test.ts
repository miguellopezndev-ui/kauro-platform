// S094 and R2-053 (R2 B16 L1, existing writers: CMD027 CreateQuote and the quote/checkout reads). Real route, real authorizers, the
// commerce adapters and PostgreSQL 17 through the runtime login roles; the superuser only reads and, where a title names a state the
// production writers reach only with time, builds it said so where it does (a SOFT deadline on the revision's UNPAID retention record:
// the fixture seals with a hard deadline only). The buyer type is B11's port bound to its labelled contract fake (SIMULATED).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CreateQuoteView, QuoteView } from "@kauro/application";
import { ContractFakeBuyerTypeReader } from "@kauro/application/testing";
import type { ClientId, FiscalProfileId, UserId } from "@kauro/domain";
import { activateAgency, recordReviewedFiscalProfile, type AgencyFixture } from "@kauro/persistence/testing";
import { paymentRoutes, paymentsWorld, read, readData, type PaymentsWorld } from "./commerce-support.js";
import { approveThroughRoute, call, clock, completed, freshKey, outcome, replayTextOf, type Person, type PlanFixture, type Reply } from "./support.js";

let pw: PaymentsWorld;
const buyer = new ContractFakeBuyerTypeReader({ clock });
before(async () => {
  pw = await paymentsWorld({ quotes: () => ({ buyerType: buyer }) });
});
after(async () => {
  await pw.stop();
});

const DAY_MS = 86_400_000;

interface Selling {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly billing: Person;
  readonly clientId: ClientId;
  readonly profileId: FiscalProfileId;
}

async function sellingAgency(label: string): Promise<Selling> {
  const { w } = pw;
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  const billing = await w.person(`${label}-billing`);
  await w.h.addMember(agency, billing.userId, "BILLING");
  await activateAgency(w.h, agency);
  const authority = await w.h.processingAuthority(agency);
  const clientId = await w.h.endClient(agency, authority, `${label} client`);
  const profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: pw.kora.userId as UserId, agencyId: agency.agencyId, issuerRef: pw.issuerRef });
  buyer.set(agency.agencyId, "AGENCY");
  return { agency, owner, billing, clientId, profileId };
}

async function approvedPlan(s: Selling, label: string): Promise<PlanFixture> {
  const { w } = pw;
  const { projectId } = await w.project(s.agency, s.clientId);
  const plan = await w.approvable(s.agency, projectId, label, "SET", { recent: true, billableSourceUnits: 40_000 });
  await approveThroughRoute(w, plan, s.owner, s.agency.agencyId);
  return plan;
}

function createQuote(s: Selling, plan: { readonly planId: string; readonly projectId: string }, key: string = freshKey("b16-quote")): Promise<Reply> {
  return call(pw.w, { url: `/api/v1/projects/${plan.projectId}/quotes`, token: s.billing.token, agency: s.agency.agencyId, key, body: { planId: plan.planId, billingProfileRef: s.profileId } });
}

interface Anchors {
  readonly records: string;
  readonly anchors: string;
}

/** Every retention anchor and deadline of the revision, as text, for a byte-for-byte comparison (versions and updated_at included). */
async function retentionOf(revisionHash: string): Promise<Anchors> {
  const q = pw.w.h.oracle;
  const revision = (await q.query<{ revision_id: string }>("SELECT revision_id FROM kauro.dataset_revisions WHERE manifest_hash = $1", [revisionHash])).rows[0]!.revision_id;
  const records = await q.query(
    "SELECT retention_id, class, version::text, anchor_id, anchor_evidence_hash, soft_deadline::text AS soft_deadline, hard_deadline::text AS hard_deadline, effective_deadline::text AS effective_deadline, state, expired_at::text AS expired_at, updated_at::text AS updated_at FROM kauro.retention_records WHERE revision_id = $1 ORDER BY class",
    [revision],
  );
  const anchors = await q.query("SELECT anchor_id, anchor_kind, occurred_at::text AS occurred_at, evidence_hash FROM kauro.retention_anchors WHERE revision_id = $1 ORDER BY anchor_kind, anchor_id", [revision]);
  assert.ok(records.rows.length >= 1 && anchors.rows.length >= 1, "the revision has its retention record and anchor");
  return { records: JSON.stringify(records.rows), anchors: JSON.stringify(anchors.rows) };
}

/**
 * The fixture's UNPAID record is sealed with a hard deadline only (no soft deadline): this gives it the soft deadline production sets,
 * seven days after the REVISION_SEALED anchor (09 "Retention schedule"; effective = minimum), as the superuser with triggers off.
 */
async function giveSoftDeadline(revisionHash: string): Promise<{ readonly revisionId: string; readonly softMs: number; readonly sealedMs: number }> {
  const c = pw.w.h.oracle;
  const rev = (await c.query<{ revision_id: string; sealed_ms: string }>("SELECT revision_id, floor(extract(epoch FROM sealed_at) * 1000)::bigint::text AS sealed_ms FROM kauro.dataset_revisions WHERE manifest_hash = $1", [revisionHash])).rows[0]!;
  try {
    await c.query("SET session_replication_role = replica");
    const upd = await c.query<{ soft_deadline: Date }>("UPDATE kauro.retention_records SET soft_deadline = hard_deadline - interval '7 days', effective_deadline = hard_deadline - interval '7 days' WHERE revision_id = $1 AND class = 'UNPAID' RETURNING soft_deadline", [rev.revision_id]);
    assert.equal(upd.rowCount, 1);
    return { revisionId: rev.revision_id, softMs: upd.rows[0]!.soft_deadline.getTime(), sealedMs: Number(rev.sealed_ms) };
  } finally {
    await c.query("RESET session_replication_role");
  }
}

test("S094: CreateQuote, a retry and a re-execution leave every retention anchor and deadline unchanged (non-zero soft deadline fixture)", async () => {
  const s = await sellingAgency("b16-s094");
  const plan = await approvedPlan(s, "b16-s094");
  const soft = await giveSoftDeadline(plan.revisionHash);
  const before = await retentionOf(plan.revisionHash);
  assert.match(before.records, /"soft_deadline":"[^"]+"/, "the fixture carries a non-zero soft deadline");
  assert.doesNotMatch(before.records, /"soft_deadline":null/);

  const key = freshKey("b16-s094");
  const firstReply = await createQuote(s, plan, key);
  const first = completed<CreateQuoteView>(firstReply, 201);
  assert.equal(first.replayed, false);
  assert.deepEqual(await retentionOf(plan.revisionHash), before, "CreateQuote moved no anchor and no deadline");
  // the quote's source promise is the soft deadline, the earlier of the two (never the later hard one)
  assert.equal(Date.parse(first.data.quote.sourceAvailableUntil), soft.softMs, "the promise is the effective (soft) deadline");

  // a retry of the same key replays byte for byte and touches nothing
  const retry = await createQuote(s, plan, key);
  assert.equal(retry.status, 201, retry.text);
  assert.equal(retry.text, replayTextOf(firstReply));
  assert.deepEqual(await retentionOf(plan.revisionHash), before, "a retry moved no anchor and no deadline");

  // a re-execution under another key supersedes the live quote with a new one issued later; the retention clock does not follow it
  const again = completed<CreateQuoteView>(await createQuote(s, plan), 201);
  assert.notEqual(again.data.quote.quoteId, first.data.quote.quoteId);
  assert.equal(again.data.supersededQuoteId, first.data.quote.quoteId);
  assert.ok(Date.parse(again.data.quote.issuedAt) >= Date.parse(first.data.quote.issuedAt));
  assert.deepEqual(await retentionOf(plan.revisionHash), before, "a re-execution moved no anchor and no deadline");
  assert.equal(Date.parse(again.data.quote.sourceAvailableUntil), soft.softMs, "and the new quote promises the very same source deadline");
  assert.ok(Date.parse(again.data.quote.expiresAt) > Date.parse(first.data.quote.expiresAt) || again.data.quote.expiresAt === first.data.quote.expiresAt, "only the price lifetime is the new quote's own");
});

test("R2-053: GetQuote shows the 14-day price expiry and the 7-day dataAvailableUntil; at source expiry checkout refuses SOURCE_EXPIRED", async () => {
  const { w } = pw;
  const s = await sellingAgency("b16-r2053");
  const plan = await approvedPlan(s, "b16-r2053");
  const soft = await giveSoftDeadline(plan.revisionHash);
  const issued = completed<CreateQuoteView>(await createQuote(s, plan), 201).data.quote;

  const view = readData<QuoteView>(await read(w, paymentRoutes.getQuote(issued.quoteId), s.billing.token, s.agency.agencyId));
  // both dates are shown and they are different dates: the price lasts 336 h from issuance, the source seven days from its seal
  assert.equal(Date.parse(view.expiresAt) - Date.parse(view.issuedAt), 14 * DAY_MS, "the price expires 14 days after issuance");
  assert.equal(Date.parse(view.sourceAvailableUntil), soft.sealedMs + 7 * DAY_MS, "the data is available until 7 days after the seal");
  assert.ok(Date.parse(view.sourceAvailableUntil) < Date.parse(view.expiresAt), "the source ends before the price does");
  assert.deepEqual([view.state, view.checkoutReady, view.checkoutBlockers], ["ISSUED", true, []], "before source expiry checkout is ready");

  // at source expiry (B07's sweeper takes the revision SEALED -> EXPIRED once the deadline is past) the price is still valid and
  // checkout is not: the view says why and CreatePaymentOrder refuses SOURCE_EXPIRED without a provider call or an order row
  await w.h.expireRevision(s.agency, plan.projectId as never, soft.revisionId as never);
  assert.ok(Date.parse(view.expiresAt) > Date.now(), "the price is still valid");
  const expired = readData<QuoteView>(await read(w, paymentRoutes.getQuote(issued.quoteId), s.billing.token, s.agency.agencyId));
  assert.deepEqual([expired.checkoutReady, expired.checkoutBlockers.includes("SOURCE_EXPIRED" as never)], [false, true]);
  assert.equal(expired.expiresAt, view.expiresAt, "the displayed price expiry does not move");
  const calls = pw.provider.calls.length;
  const refused = await call(w, { url: paymentRoutes.createPaymentOrder(issued.quoteId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("b16-r2053"), body: { termsHash: issued.termsHash } });
  assert.equal(outcome(w, refused), "422 SOURCE_EXPIRED -");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [issued.quoteId]), 0, "no order row");
  assert.equal(pw.provider.calls.length, calls, "no provider call");
});

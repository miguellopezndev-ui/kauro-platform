// The seams of the B07 + B09 merge through the api the composition root builds (docs/design/B07-B09-merge.md; B07 design §17
// items 5-7, B09 design §15 items 5-6): the ports each package defined for the other, bound in apps/api edition.ts to the other
// package's own persistence — never a contract fake — and exercised through the real routes, the pg units of work of the runtime
// login roles and a real PostgreSQL 17:
//   - CMD012's CommercialScopeInspector (B07) names B09's live commercial authorizations bound to the replaced revision;
//   - B09's SourceAvailabilityReader answers from B07's retention record of the quoted revision, for the request handlers and for
//     the payment service (migration 0018), and checkout follows it through B07's retention expiry;
//   - B09's SourceLineageReader answers from CMD012's lineage under the payment service's own column grant.
// The provider, its webhook verifier and B08's admission stay M2's labelled contract fakes (SIMULATED): nothing here is provider
// evidence. Every check reads durable rows through the superuser oracle. Nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CreateRevisionView, QuoteView } from "@kauro/application";
import type { Sha256Hex } from "@kauro/contracts";
import { sourceAvailabilityHashOf, sourceLineageHashOf, type CommerceUnitOfWork, type ProjectId, type RevisionId } from "@kauro/domain";
import { sourceAvailabilityReader, sourceLineageReader } from "../src/index.js";
import { paymentRoutes, paymentsWorld, read, readData, type PaymentsWorld } from "./commerce-support.js";
import { createRevision, projectPointer } from "./source-support.js";
import { call, completed, freshKey, outcome } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

async function revisionOfHash(revisionHash: string): Promise<{ readonly revisionId: RevisionId; readonly projectId: ProjectId }> {
  const r = await pw.w.h.oracle.query<{ revision_id: string; project_id: string }>("SELECT revision_id, project_id FROM kauro.dataset_revisions WHERE manifest_hash = $1", [revisionHash]);
  const row = r.rows[0];
  assert.ok(row, "the quoted revision exists");
  return { revisionId: row.revision_id as RevisionId, projectId: row.project_id as ProjectId };
}

/** The retention record B07 wrote for the revision, its deadlines as exact instants (the oracle's reading). */
async function recordOf(revisionId: string): Promise<{ readonly retentionId: string; readonly state: string; readonly effectiveDeadline: string; readonly hardDeadline: string; readonly sealedAt: string }> {
  const exact = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const r = await pw.w.h.oracle.query<{ retention_id: string; state: string; effective: string; hard: string; sealed: string }>(
    `SELECT x.retention_id, x.state, ${exact("x.effective_deadline")} AS effective, ${exact("x.hard_deadline")} AS hard, ${exact("r.sealed_at")} AS sealed
       FROM kauro.retention_records x JOIN kauro.dataset_revisions r ON r.revision_id = x.revision_id WHERE x.revision_id = $1`,
    [revisionId],
  );
  assert.equal(r.rows.length, 1, "one UNPAID record of the seal");
  const row = r.rows[0]!;
  return { retentionId: row.retention_id, state: row.state, effectiveDeadline: row.effective, hardDeadline: row.hard, sealedAt: row.sealed };
}

test("B07+B09 seam, CommercialScopeInspector (B07 §17 item 7, B09 §15 item 6): CreateRevision over a revision a paid purchase rests on names its live CommercialAuthorization — in the reply's invalidated authority and in dataset_revision.superseded.v1 — read from B09's commercial authorizations in CMD012's own unit of work; a replaced revision nothing was bought on names none", async () => {
  const { w } = pw;
  const purchase = await pw.paidProject("seam-scope");
  const paid = await revisionOfHash(purchase.plan.revisionHash);
  const pointer = await projectPointer(w, paid.projectId);
  const replaced = completed<CreateRevisionView>(await createRevision(w, paid.projectId, pointer.version, paid.revisionId, { key: freshKey("seam-scope") }), 201);
  assert.deepEqual(replaced.data.invalidated.commercialAuthorizationIds, [purchase.authorizationId]);
  const superseded = await w.h.oracle.query<{ payload: { affectedCommercialAuthorizationIds: string[] } }>(
    "SELECT payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'dataset_revision.superseded.v1'",
    [paid.revisionId],
  );
  assert.deepEqual(superseded.rows.map((r) => r.payload.affectedCommercialAuthorizationIds), [[purchase.authorizationId]]);
  // the authorization itself is untouched by CMD012 (its revocation is the execution consumer's, B08)
  assert.equal((await w.row<{ state: string }>("commercial_authorizations", "authorization_id = $1", [purchase.authorizationId]))?.state, "ACTIVE");

  // negative control: an approved, quoted but unpaid revision binds no authorization
  const unpaid = await pw.readyQuote("seam-scope-unpaid");
  const quoted = await revisionOfHash(unpaid.revisionHash);
  const other = completed<CreateRevisionView>(await createRevision(w, quoted.projectId, (await projectPointer(w, quoted.projectId)).version, quoted.revisionId, { key: freshKey("seam-scope-unpaid") }), 201);
  assert.deepEqual(other.data.invalidated.commercialAuthorizationIds, []);
});

test("B07+B09 seam, SourceAvailabilityReader (B07 §17 item 5, B09 §15 item 5, D-QUOTE-B7): the quoted source's availability is B07's retention record — its SEALED revision, seal instant and UNPAID deadlines with their evidence hash — for the request handlers and, in its adopted agency only, the payment service (migration 0018); once B07's retention sweeper expires the record and the revision, GetQuote shows SOURCE_EXPIRED and CreatePaymentOrder answers 422 SOURCE_EXPIRED writing nothing", async () => {
  const { w } = pw;
  const quote = await pw.readyQuote("seam-availability");
  const { revisionId, projectId } = await revisionOfHash(quote.revisionHash);
  const record = await recordOf(revisionId);
  assert.equal(record.state, "ACTIVE");
  const request = { agencyId: w.A.agencyId, projectId, revisionHash: quote.revisionHash as Sha256Hex };
  const expected = { revisionId, state: "SEALED", sealedAt: record.sealedAt, effectiveDeadline: record.effectiveDeadline, hardDeadline: record.hardDeadline };
  const asTenant = await w.h.commerce.run(w.h.tenant(w.A.agencyId, w.A.ownerUserId), (uow) => sourceAvailabilityReader.availabilityOf(uow, request));
  assert.deepEqual(asTenant, { ...expected, evidenceHash: sourceAvailabilityHashOf({ ...expected, manifestHash: quote.revisionHash as Sha256Hex, retentionId: record.retentionId }) });
  assert.equal(Date.parse(record.hardDeadline) - Date.parse(record.sealedAt) <= 14 * 86_400_000, true, "the UNPAID hard cap from the first seal of the bytes");
  assert.equal(sourceAvailabilityReader.binding, "PLATFORM");
  // the payment service reads the same answer in the agency it adopted (the order's scope), and nothing in another agency's
  const orders = await w.h.oracle.query<{ order_id: string }>("SELECT order_id FROM kauro.payment_orders WHERE agency_id = $1 ORDER BY created_at LIMIT 1", [w.A.agencyId]);
  const anyOrder = orders.rows[0]?.order_id ?? (await pw.paidProject("seam-availability-scope")).orderId;
  const asService = await w.h.commerce.run(w.h.service(), async (uow) => {
    assert.notEqual(await uow.adoptScope("PAYMENT_ORDER", anyOrder), null);
    return sourceAvailabilityReader.availabilityOf(uow, request);
  });
  assert.deepEqual(asService, asTenant);
  const foreign = await w.h.commerce.run(w.h.tenant(w.B.agencyId, w.B.ownerUserId), (uow) => sourceAvailabilityReader.availabilityOf(uow, request));
  assert.equal(foreign, null, "another agency's revision is not visible, even named by its own agency id");

  // B07's retention sweeper: the record and the revision EXPIRED (retention_expires on the server clock past the deadline)
  await w.h.expireRevision(w.A, projectId, revisionId);
  const expired = await w.h.commerce.run(w.h.tenant(w.A.agencyId, w.A.ownerUserId), (uow) => sourceAvailabilityReader.availabilityOf(uow, request));
  assert.equal(expired?.state, "EXPIRED");
  assert.equal(expired?.effectiveDeadline, record.effectiveDeadline, "the deadline that passed, never moved");
  const view = readData<QuoteView>(await read(w, paymentRoutes.getQuote(quote.quoteId), w.billing.token));
  assert.deepEqual([view.checkoutReady, view.checkoutBlockers.includes("SOURCE_EXPIRED" as never)], [false, true]);
  const before = await pw.effects();
  const refused = await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: w.billing.token, key: freshKey("seam-availability"), body: { termsHash: quote.termsHash } });
  assert.equal(outcome(w, refused), "422 SOURCE_EXPIRED -");
  assert.deepEqual({ ...(await pw.effects()), security_events: 0 }, { ...before, security_events: 0 }, "nothing written, no provider call");
});

test("B07+B09 seam, SourceLineageReader (B09 D-QUOTE-B6, B07 D-REV-1): the replacement's lineage is CMD012's — read by the payment service in its adopted agency under its own column grant: the replaced and replacement revisions, the replacement SEALED once the source lifecycle sealed it, with the evidence hash of the path; a revision sealed beside the paid one without lineage answers none", async () => {
  const { w } = pw;
  const purchase = await pw.paidProject("seam-lineage");
  const paid = await revisionOfHash(purchase.plan.revisionHash);
  // a revision sealed beside the paid one, no CMD012 lineage (the source lifecycle's fixture inserts it without supersedes)
  const beside = await w.revision(w.A, paid.projectId, "SEALED", { recent: true });
  // CMD012 replaces the paid revision, then the source lifecycle seals the successor
  const created = completed<CreateRevisionView>(await createRevision(w, paid.projectId, (await projectPointer(w, paid.projectId)).version, paid.revisionId, { key: freshKey("seam-lineage") }), 201);
  const successor = created.data.revision.revisionId as RevisionId;
  const sealed = await w.revision(w.A, paid.projectId, "SEALED", { recent: true });
  assert.equal(sealed.revisionId, successor);
  const asService = <T>(fn: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T> =>
    w.h.commerce.run(w.h.service(), async (uow) => {
      assert.notEqual(await uow.adoptScope("PAYMENT_ORDER", purchase.orderId), null);
      return fn(uow);
    });
  const request = { agencyId: w.A.agencyId, projectId: paid.projectId, replacedRevisionHash: purchase.plan.revisionHash as Sha256Hex };
  const lineage = await asService((uow) => sourceLineageReader.replacementOf(uow, { ...request, replacementRevisionHash: sealed.revisionHash }));
  const facts = { replacedRevisionId: paid.revisionId, replacementRevisionId: successor, replacementSealed: true };
  assert.deepEqual(lineage, { ...facts, evidenceHash: sourceLineageHashOf({ ...facts, replacedRevisionHash: purchase.plan.revisionHash as Sha256Hex, replacementRevisionHash: sealed.revisionHash, path: [paid.revisionId, successor] }) });
  assert.equal(sourceLineageReader.binding, "PLATFORM");
  assert.equal(await asService((uow) => sourceLineageReader.replacementOf(uow, { ...request, replacementRevisionHash: beside.revisionHash })), null, "no lineage from the paid revision to one sealed beside it");
  assert.equal(await asService((uow) => sourceLineageReader.replacementOf(uow, { replacedRevisionHash: sealed.revisionHash, replacementRevisionHash: purchase.plan.revisionHash as Sha256Hex, agencyId: w.A.agencyId, projectId: paid.projectId })), null, "lineage runs forward only");
});

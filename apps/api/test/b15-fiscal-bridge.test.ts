// CMD035 through the lawful manual-assisted bridge (package B15 lane L6; docs/design/B15-B17-B18-local-plan.md sections 1-5, M6;
// docs/design/B15-case-map.md R2-083 OK). A MANUAL_BRIDGE issuer is a human procedure (integration class PROVIDER, never a contract
// fake, 0013): the submit prepares the owner's or accountant's action and the legal number arrives by observation; the document is
// never ISSUED by assumption and an absence never proves anything for it. The bridge's list is the labelled fake's (SIMULATED).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { reconcileTaxDocument } from "@kauro/application";
import type { CorrelationId, FiscalIssuerRef, TaxDocumentId } from "@kauro/domain";
import { fiscalRouteFake, type FiscalRouteFake } from "./b15-fiscal-pages-fake.js";
import { brief, dbPast, doc, eventsOf, fiscalWorld, issue, journalOf, reReview, request, validatedInvoice, type Doc, type FiscalWorld } from "./b15-fiscal-support.js";
import { freshKey, ids, sha } from "./support.js";

/** Every cell is bounded: a hold never reached fails the cell instead of hanging the file. */
const CELL = { timeout: 120_000 };

let fw: FiscalWorld;
let bridgeRef: FiscalIssuerRef;
let bridge: FiscalRouteFake;
before(async () => {
  fw = await fiscalWorld();
  bridgeRef = ids.next() as FiscalIssuerRef;
  const oracle = fw.pw.w.h.oracle;
  await oracle.query(
    `INSERT INTO kauro.fiscal_issuers (issuer_ref, jurisdiction, legal_identity_hash, legal_fact_status, route_kind, integration_class, numbering_authorization_ref, created_at, updated_at)
     VALUES ($1, 'CO', $2, 'PROFESSIONALLY_CONFIRMED', 'MANUAL_BRIDGE', 'PROVIDER', 'DIAN-18764000009', now(), now())`,
    [bridgeRef, sha(`bridge-legal-identity-${bridgeRef}`)],
  );
  await oracle.query("UPDATE kauro.fiscal_issuers SET valid_from = now() - interval '24 hours' WHERE issuer_ref = $1", [bridgeRef]);
  bridge = fiscalRouteFake({ bridge: fw.pw.fiscalBridge, issuerRef: bridgeRef, routeKind: "MANUAL_BRIDGE" });
  fw.routes.set(bridgeRef, bridge);
  // agency A's reviewed profile now names the bridge issuer: its sales' documents are the bridge's
  await reReview(fw, { issuerRef: bridgeRef });
});
after(async () => {
  await fw.stop();
});

function reconcile(d: Pick<Doc, "document_id" | "order_id">, rt = fw.rt) {
  return reconcileTaxDocument(rt, { documentId: d.document_id as TaxDocumentId, scope: { kind: "PAYMENT_ORDER", key: d.order_id }, correlationId: ids.next() as CorrelationId });
}

test("R2-083: OK a MANUAL_BRIDGE issuer prepares the lawful bridge action (ACTION_PREPARED) and claims no issuance", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-bridge-ok");
  assert.equal(inv.issuer_ref, bridgeRef);
  bridge.script("ACTION_PREPARED");
  const key = freshKey("bridge-ok");
  const o = await issue(fw, request(inv, key));
  assert.equal(brief(o), "ANSWERED 202 SUBMITTING");
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.bridge_action_ref, d.legal_number, d.fiscal_status, d.provider_document_id], ["SUBMITTING", `bridge-action-${inv.document_id}`, null, null, null]);
  if (o.kind === "ANSWERED") assert.equal(o.view.bridgeActionRef, d.bridge_action_ref);
  assert.deepEqual(await eventsOf(fw, inv.document_id), ["tax_document.drafted.v1", "tax_document.validated.v1", "tax_document.submitting.v1", "tax_document.submitting.v1"]);
  assert.equal(bridge.submits(d.issue_request_hash!), 1);
  // a replay of the key observes: the same bridge action, never a second one, never an issuance by assumption
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 202 SUBMITTING replayed");
  assert.equal(bridge.submits(d.issue_request_hash!), 1);
  assert.deepEqual([(await doc(fw, inv.document_id)).bridge_action_ref, (await doc(fw, inv.document_id)).version], [d.bridge_action_ref, d.version]);
  // the accountant obtained the legal number with the DIAN acceptance: observed, ISSUED
  bridge.publish(d.issue_request_hash as never, "ACCEPTED");
  assert.equal((await reconcile(d)).kind, "SETTLED");
  const issued = await doc(fw, inv.document_id);
  assert.deepEqual([issued.state, issued.fiscal_status, issued.bridge_action_ref], ["ISSUED", "ACCEPTED", d.bridge_action_ref]);
  assert.match(issued.legal_number ?? "", /^SETP/);
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 200 ISSUED replayed");
  assert.deepEqual(await journalOf(fw, key), ["COMMITTED"]);
});

test("R2-083: crash after the ACTION_PREPARED commit: SUBMITTING with bridge_action_ref, observed later, never ISSUED by assumption", CELL, async () => {
  const rt = { ...fw.rt, submitWindowMs: 1_000 };
  const inv = await validatedInvoice(fw, "b15-bridge-crash");
  bridge.script("ACTION_PREPARED");
  const key = freshKey("bridge-crash");
  // the conclusion recording the action committed; the answer died with the process
  await issue(fw, request(inv, key), rt);
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.bridge_action_ref !== null], ["SUBMITTING", true]);
  // past the deadline, a complete page set without the document proves nothing for a bridge: still SUBMITTING, never REJECTED
  await dbPast(fw, d.submit_deadline_at!);
  const observed = await reconcile(d, rt);
  assert.equal(observed.kind, "OBSERVING");
  assert.deepEqual([(await doc(fw, inv.document_id)).state, (await doc(fw, inv.document_id)).rejection_code, (await doc(fw, inv.document_id)).version], ["SUBMITTING", null, d.version]);
  assert.equal(brief(await issue(fw, request(inv, key), rt)), "ANSWERED 202 SUBMITTING replayed");
  assert.equal(bridge.submits(d.issue_request_hash!), 1);
  // a pending acceptance is not an issuance either
  bridge.publish(d.issue_request_hash as never, "PENDING");
  assert.equal((await reconcile(d, rt)).kind, "OBSERVING");
  assert.equal((await doc(fw, inv.document_id)).state, "UNCERTAIN");
  bridge.publish(d.issue_request_hash as never, "ACCEPTED");
  assert.equal((await reconcile(d, rt)).kind, "SETTLED");
  assert.equal((await doc(fw, inv.document_id)).state, "ISSUED");
});

test("CMD035-DENY: a MANUAL_BRIDGE issuer whose legal facts are only owner-declared is refused (ISSUER_FACTS_UNCONFIRMED) beside the confirmed sibling", CELL, async () => {
  const oracle = fw.pw.w.h.oracle;
  const denied = await validatedInvoice(fw, "b15-bridge-facts");
  const before = bridge.totalSubmits();
  await oracle.query("UPDATE kauro.fiscal_issuers SET legal_fact_status = 'OWNER_DECLARED' WHERE issuer_ref = $1", [bridgeRef]);
  const key = freshKey("bridge-facts");
  try {
    assert.equal(brief(await issue(fw, request(denied, key))), "REFUSED PRECONDITION_FAILED ISSUER_FACTS_UNCONFIRMED");
  } finally {
    await oracle.query("UPDATE kauro.fiscal_issuers SET legal_fact_status = 'PROFESSIONALLY_CONFIRMED' WHERE issuer_ref = $1", [bridgeRef]);
  }
  const d = await doc(fw, denied.document_id);
  assert.deepEqual([d.state, d.version, d.issue_request_hash], ["VALIDATED", denied.version, null]);
  assert.deepEqual(await journalOf(fw, key), []);
  assert.equal(bridge.totalSubmits(), before);
  bridge.script("ACTION_PREPARED");
  assert.equal(brief(await issue(fw, request(denied, freshKey("bridge-facts-ok")))), "ANSWERED 202 SUBMITTING");
});

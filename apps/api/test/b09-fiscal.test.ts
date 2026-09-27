// The FISCAL consumer of the payment service (package B09, stage-2 mandate M3; design §8.1, D-FISC-B1..B6; docs/design/B09-case-map.md
// R2-128). A completed capture's event, published by the webhook's application through the api the composition root builds, is
// delivered by the payment dispatcher to FISCAL, which drafts the invoice under the profile version of the sale's tax point (M2's
// planFiscalDocument; FiscalRepository.saleProfileAt) and validates it only when the treatment is reviewed (the database re-checks
// it, KP011). Nothing here receives a currency, a payer country, an address or an email: nothing can infer an exemption (R2-128).
// The provider and the fiscal bridge are M2's labelled contract fakes (CONTRACT_FAKE, SIMULATED: the bridge prepares; issuance,
// CMD035, is package B15's).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { WebhookAck } from "@kauro/application";
import type { FiscalProfileId, TaxDocumentId, TaxDocumentRecord } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { reevaluateBlockedDrafts } from "../src/index.js";
import { checkout, deliver, dispatch, paymentWorld, rows, sha, type PaymentWorld } from "./payment-support.js";
import { clock, completed } from "./support.js";

let pw: PaymentWorld;
before(async () => {
  pw = await paymentWorld();
});
after(async () => {
  await pw.stop();
});

type Document = { readonly document_id: string; readonly kind: string; readonly state: string; readonly tax_treatment: string; readonly fiscal_profile_id: string; readonly blocked_reason: string | null; readonly service_cents: string; readonly tax_cents: string; readonly legal_number: string | null };

async function documentsOf(captureId: string): Promise<Document[]> {
  return rows<Document>(pw, "SELECT document_id, kind, state, tax_treatment, fiscal_profile_id, blocked_reason, service_cents::text, tax_cents::text, legal_number FROM kauro.tax_documents WHERE capture_id = $1 ORDER BY created_at", [captureId]);
}

/** A capture paid at the provider and applied from the provider's webhook; the capture fact and its order as recorded. */
async function captured(order: Awaited<ReturnType<typeof checkout>>) {
  pw.paypal.approve(order.providerOrderId);
  const providerCaptureId = pw.paypal.captureAtProvider(order.providerOrderId);
  const d = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
  assert.equal(completed<WebhookAck>(d.reply, 200).data.inboxState, "APPLIED");
  const capture = (await rows<{ capture_id: string; status: string }>(pw, "SELECT capture_id, status FROM kauro.capture_facts WHERE order_id = $1", [order.orderId]))[0]!;
  const orderState = (await rows<{ state: string }>(pw, "SELECT state FROM kauro.payment_orders WHERE order_id = $1", [order.orderId]))[0]!.state;
  return { capture, orderState };
}

/** A version of agency A's fiscal profile recorded by the corporate owner in the finance scope it adopts (FiscalRepository.recordProfile). */
async function recordProfile(input: { readonly supersedes: FiscalProfileId; readonly treatment: "REVIEW_REQUIRED" | "EXEMPT_EXPORT"; readonly validFrom?: string }): Promise<FiscalProfileId> {
  const { h, A } = pw.w;
  return h.commerce.run(h.operator(pw.kora), async (uow) => {
    await uow.adoptFinanceScope(A.agencyId);
    const profileId = uow.ids.next() as FiscalProfileId;
    const reviewed = input.treatment === "EXEMPT_EXPORT";
    await uow.commerce.fiscal.recordProfile({
      profileId,
      agencyId: A.agencyId,
      operatorLegalRef: pw.issuerRef,
      customerLegalRef: uow.ids.next(),
      serviceClassification: "Data services",
      territory: "Colombia and abroad",
      taxTreatment: input.treatment,
      taxRule: reviewed ? "ZERO_REVIEWED" : "UNRESOLVED",
      taxRateBps: 0,
      evidenceHash: sha(`fiscal-evidence-${profileId}`),
      ...(reviewed ? { exportEvidenceHash: sha(`export-facts-${profileId}`), reviewedByUserId: pw.kora } : {}),
      validFrom: (input.validFrom ?? toUtcInstant(clock.nowMs() - 3_600_000)) as never,
      supersedesProfileId: input.supersedes,
      recordedAt: clock.now(),
    });
    return profileId;
  });
}

let unreviewedProfile: FiscalProfileId | null = null;
let blockedCapture: string | null = null;

test("R2-128: the FISCAL consumer drafts a blocked invoice for an unreviewed profile and a validated one for a reviewed exempt export; the capture is reconciled in both", async () => {
  // a sale under the reviewed EXEMPT_EXPORT version: the invoice is drafted under it and validated
  const exempt = await captured(await checkout(pw, "fiscal-exempt"));
  assert.deepEqual([exempt.capture.status, exempt.orderState], ["COMPLETED", "CAPTURED"]);
  // a second checkout quoted under the same reviewed version, whose treatment is then withdrawn for review before its capture completes
  const pending = await checkout(pw, "fiscal-unreviewed");
  unreviewedProfile = await recordProfile({ supersedes: pw.profileId, treatment: "REVIEW_REQUIRED" });
  const unreviewed = await captured(pending);
  // the capture's reconciliation does not depend on the fiscal treatment: the fact, the order and the entitlement stand
  assert.deepEqual([unreviewed.capture.status, unreviewed.orderState], ["COMPLETED", "CAPTURED"]);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.commercial_authorizations WHERE capture_id = $1 AND state = 'ACTIVE'", [unreviewed.capture.capture_id])).length, 1);
  blockedCapture = unreviewed.capture.capture_id;

  const pass = await dispatch(pw, "FISCAL");
  assert.equal(pass.held, false);
  assert.deepEqual((await documentsOf(exempt.capture.capture_id)).map((d) => [d.kind, d.state, d.tax_treatment, d.fiscal_profile_id, d.blocked_reason, d.service_cents, d.tax_cents, d.legal_number]), [
    ["INVOICE", "VALIDATED", "EXEMPT_EXPORT", pw.profileId, null, "97125", "0", null],
  ]);
  assert.deepEqual((await documentsOf(unreviewed.capture.capture_id)).map((d) => [d.kind, d.state, d.tax_treatment, d.fiscal_profile_id, d.blocked_reason, d.legal_number]), [
    ["INVOICE", "DRAFT", "REVIEW_REQUIRED", unreviewedProfile, "FISCAL_TREATMENT_UNREVIEWED", null],
  ]);
  const events = await rows<{ event_type: string; actor_kind: string }>(pw, "SELECT e.event_type, e.actor_kind FROM kauro.domain_events e JOIN kauro.tax_documents d ON d.document_id::text = e.aggregate_id::text WHERE d.capture_id IN ($1, $2) ORDER BY e.sequence", [exempt.capture.capture_id, unreviewed.capture.capture_id]);
  assert.deepEqual(events.map((e) => e.event_type).sort(), ["tax_document.drafted.v1", "tax_document.drafted.v1", "tax_document.validated.v1"]);
  assert.ok(events.every((e) => e.actor_kind === "SERVICE"));

  // what the bridge prepares for issuance is the selected reviewed treatment of the validated document (SIMULATED: prepare only)
  const [invoice] = await documentsOf(exempt.capture.capture_id);
  const packet = await pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: pw.w.h.service().correlationId }, async (uow) => {
    await uow.adoptScope("PROVIDER_CAPTURE", `paypal|SANDBOX|${(await rows<{ provider_capture_id: string }>(pw, "SELECT provider_capture_id FROM kauro.capture_facts WHERE capture_id = $1", [exempt.capture.capture_id]))[0]!.provider_capture_id}`);
    const document = (await uow.commerce.taxDocuments.get(invoice!.document_id as TaxDocumentId)) as TaxDocumentRecord;
    const profile = await uow.commerce.fiscal.getProfile(pw.profileId);
    const issuer = await uow.commerce.fiscal.getIssuer(pw.issuerRef);
    return pw.fiscalBridge.prepare(document, { profile: profile!, issuer: issuer! });
  });
  assert.deepEqual([packet.kind, packet.treatment, packet.serviceCents, packet.taxCents, packet.currency], ["INVOICE", "EXEMPT_EXPORT", 97125n, 0n, "USD"]);

  // at least once, drafted once: a second pass finds nothing new, and the one live invoice per capture stands
  await dispatch(pw, "FISCAL");
  assert.equal((await documentsOf(exempt.capture.capture_id)).length, 1);
  assert.equal((await documentsOf(unreviewed.capture.capture_id)).length, 1);
});

test("D-FISC-B6: a later review whose validity reaches back to the sale resolves the blocked draft's unknown treatment — the draft is re-pointed at the reviewed version and validated; a reviewed treatment is never replaced", async () => {
  assert.ok(unreviewedProfile !== null && blockedCapture !== null, "the R2-128 test ran first");
  const reviewedAgain = await recordProfile({ supersedes: unreviewedProfile, treatment: "EXEMPT_EXPORT", validFrom: toUtcInstant(clock.nowMs() - 86_400_000) });
  const order = (await rows<{ order_id: string }>(pw, "SELECT order_id FROM kauro.capture_facts WHERE capture_id = $1", [blockedCapture]))[0]!.order_id;
  const moved = await pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: pw.w.h.service().correlationId }, async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", order);
    return reevaluateBlockedDrafts(uow, clock.now());
  });
  assert.equal(moved, 1);
  assert.deepEqual((await documentsOf(blockedCapture)).map((d) => [d.kind, d.state, d.tax_treatment, d.fiscal_profile_id, d.blocked_reason]), [["INVOICE", "VALIDATED", "EXEMPT_EXPORT", reviewedAgain, null]]);
  // the invoice validated under the first reviewed version keeps it: a later version never replaces a reviewed treatment for its sale
  const firstSale = await rows<{ fiscal_profile_id: string; state: string }>(pw, "SELECT fiscal_profile_id, state FROM kauro.tax_documents WHERE fiscal_profile_id = $1", [pw.profileId]);
  assert.deepEqual(firstSale.map((d) => d.state), ["VALIDATED"]);
});

/**
 * Order 27A: what a received and applied payment may produce fiscally (DIAN not activated: no RUT, no verification; O27A spec exclusions).
 *
 *  - A payment receipt is proof of money received; it is never an invoice and never claims DIAN acceptance (R2 15: a provider PDF does
 *    not prove DIAN acceptance).
 *  - An electronic invoice is issuable only when every prerequisite holds AND the activation is on: a registered RUT, a fiscal issuer
 *    QUALIFIED with its numbering authorization, and the DIAN verification recorded. Until then the answer is RECEIPT_ONLY with every
 *    blocker named, so nothing is issued and nothing is promised.
 *  - The invoiced amounts are the applied service and tax only, in USD minor units: an excess is not revenue (it is refunded) and never
 *    appears on an invoice; a partial payment does not invoice an unpaid remainder.
 *  - Refunding service or tax of an invoiced payment needs a credit note; refunding only an excess needs none (refunds.ts
 *    RefundEffects.creditNoteRequired, the same rule).
 * Pure.
 */
import { assertMoney } from "./money.js";
import { O27A_ACTIVATION, type O27AActivation } from "./o27a-flags.js";
import type { PaymentReceipt } from "./o27a-receipts.js";

export interface FiscalReadiness {
  readonly rutRegistered: boolean;
  readonly issuerQualified: boolean;
  readonly numberingAuthorized: boolean;
  readonly dianVerificationRecorded: boolean;
}

export type InvoiceBlocker = "DIAN_NOT_ACTIVE" | "RUT_NOT_REGISTERED" | "ISSUER_NOT_QUALIFIED" | "NUMBERING_NOT_AUTHORIZED" | "DIAN_VERIFICATION_MISSING" | "NOTHING_TO_INVOICE";

export type InvoiceDecision =
  | { readonly kind: "RECEIPT_ONLY"; readonly blockers: ReadonlyArray<InvoiceBlocker>; readonly receiptIsInvoice: false }
  | { readonly kind: "ISSUE_ELECTRONIC_INVOICE"; readonly currency: "USD"; readonly serviceCents: bigint; readonly taxCents: bigint; readonly totalCents: bigint };

export function decideInvoice(receipt: Pick<PaymentReceipt, "appliedServiceCents" | "appliedTaxCents" | "excessCents" | "currency">, readiness: FiscalReadiness, activation: O27AActivation = O27A_ACTIVATION): InvoiceDecision {
  const service = assertMoney(receipt.appliedServiceCents);
  const tax = assertMoney(receipt.appliedTaxCents);
  assertMoney(receipt.excessCents);
  if (receipt.currency !== "USD") throw new RangeError("receipts are USD only");
  const blockers: InvoiceBlocker[] = [];
  if (!activation.dianIssuance) blockers.push("DIAN_NOT_ACTIVE");
  if (!readiness.rutRegistered) blockers.push("RUT_NOT_REGISTERED");
  if (!readiness.issuerQualified) blockers.push("ISSUER_NOT_QUALIFIED");
  if (!readiness.numberingAuthorized) blockers.push("NUMBERING_NOT_AUTHORIZED");
  if (!readiness.dianVerificationRecorded) blockers.push("DIAN_VERIFICATION_MISSING");
  if (service + tax === 0n) blockers.push("NOTHING_TO_INVOICE");
  if (blockers.length > 0) return { kind: "RECEIPT_ONLY", blockers, receiptIsInvoice: false };
  return { kind: "ISSUE_ELECTRONIC_INVOICE", currency: "USD", serviceCents: service, taxCents: tax, totalCents: service + tax };
}

/** A refund of an invoiced payment needs a credit note exactly when it returns service or tax. */
export function creditNoteRequired(refund: { readonly serviceCents: bigint; readonly taxCents: bigint; readonly excessCents: bigint }, invoiced: boolean): boolean {
  return invoiced && (assertMoney(refund.serviceCents) > 0n || assertMoney(refund.taxCents) > 0n);
}

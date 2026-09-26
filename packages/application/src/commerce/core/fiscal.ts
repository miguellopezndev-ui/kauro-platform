/**
 * planFiscalDocument — the FISCAL consumer's decision (design §8.1; D-FISC-B1..B6; R2-128): which fiscal document a reconciled
 * financial event drafts, under which profile version, and whether the draft validates or stays blocked with its concrete blocker.
 * Pure: the consumer reads the facts inside its SERVICE unit of work (the sale's profile version through
 * FiscalRepository.saleProfileAt, after the profile's transition lock) and applies the plan through TaxDocumentRepository; the
 * database re-checks every validation (tax_documents_validation_guard, KP011).
 *
 *  - INVOICE (capture.completed.v1): the capture's allocation — the collected service and tax — under the version of the sale's tax
 *    point, the capture's completion (saleProfileAt: the version current then while it carries a reviewed treatment, else a later
 *    review whose validity reaches back to the sale, else the unknown; D-FISC-B6), judged by resolveFiscalTreatment against the rule
 *    the sale was priced with. A capture that pays nothing of the obligation (an excess) is not a sale (D-FISC-B2). An unreviewed
 *    treatment is a blocked DRAFT; the capture's reconciliation is untouched (R2-128).
 *  - CREDIT_NOTE (refund.completed.v1 with a credit note required): the refund's approved service and tax with exactly the fiscal
 *    snapshot of the invoice it corrects — never re-chosen at the refund's completion (D-FISC-B5; B09-N5) — validated only once
 *    that invoice is ISSUED (a credit note waits for its invoice's issuance).
 *  - REEVALUATE (a blocked draft, when the reviewed facts changed): an invoice draft is re-pointed at the version saleProfileAt now
 *    chooses (a later review resolves an unknown treatment; it never changes a known one); a credit note draft follows its invoice.
 * No input carries a currency, a payer country, an address or an email: nothing here can infer an exemption (R2-128).
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  CaptureFactRecord,
  FiscalBlocker,
  FiscalIssuerRecord,
  FiscalProfileRecord,
  NewTaxDocument,
  PaymentOrderRecord,
  RefundRecord,
  TaxDocumentRecord,
  TaxRuleSnapshot,
  TaxTreatment,
} from "@kauro/domain";
import { resolveFiscalTreatment } from "@kauro/domain";

export type FiscalInput =
  | {
      readonly kind: "INVOICE";
      readonly capture: CaptureFactRecord;
      readonly order: Pick<PaymentOrderRecord, "agencyId" | "orderId">;
      /** The reviewed rule the sale was priced with (the quote's tax snapshot). */
      readonly priced: TaxRuleSnapshot;
      /** FiscalRepository.saleProfileAt(agency, the capture's completion). */
      readonly saleProfile: FiscalProfileRecord | null;
      /** The agency's current version, drafted against (blocked) only when no version was in force at the tax point. */
      readonly currentProfile: FiscalProfileRecord | null;
      /** The issuer route of the profile's operator legal ref (FiscalRepository.getIssuer). */
      readonly issuer: FiscalIssuerRecord | null;
      /** The capture's live invoice, if one exists (one live invoice per capture). */
      readonly existing: TaxDocumentRecord | null;
    }
  | {
      readonly kind: "CREDIT_NOTE";
      readonly refund: RefundRecord;
      /** The live invoice of the refund's capture. */
      readonly invoice: TaxDocumentRecord | null;
      /** The refund's live credit note, if one exists (one live credit note per refund). */
      readonly existing: TaxDocumentRecord | null;
    }
  | {
      readonly kind: "REEVALUATE";
      readonly draft: TaxDocumentRecord;
      readonly capture: CaptureFactRecord;
      readonly priced: TaxRuleSnapshot;
      readonly saleProfile: FiscalProfileRecord | null;
      readonly issuer: FiscalIssuerRecord | null;
      /** For a credit note draft: the invoice it corrects, as it stands now. */
      readonly invoice: TaxDocumentRecord | null;
    };

type DraftFields = Omit<NewTaxDocument, "documentId" | "createdAt">;
type RedraftChange = { readonly fiscalProfileId: TaxDocumentRecord["fiscalProfileId"]; readonly issuerRef: TaxDocumentRecord["issuerRef"]; readonly taxTreatment: TaxTreatment; readonly taxCents: bigint; readonly blockedReason: string | null };

export type FiscalPlan =
  | {
      readonly kind: "NONE";
      readonly reason: "ALREADY_DRAFTED" | "NOT_A_SALE" | "NO_CREDIT_NOTE_REQUIRED" | "REFUND_NOT_COMPLETED" | "AWAIT_INVOICE" | "NO_PROFILE" | "NO_TAX_POINT" | "UNCHANGED" | "NOT_A_DRAFT";
    }
  /** Draft the document; `validate` moves it DRAFT → VALIDATED in the same unit of work. */
  | { readonly kind: "DRAFT"; readonly document: DraftFields; readonly validate: boolean }
  /** A blocked draft re-pointed (TaxDocumentRepository.redraft), and validated when it no longer blocks. */
  | { readonly kind: "REDRAFT"; readonly documentId: TaxDocumentRecord["documentId"]; readonly expectedVersion: number; readonly change: RedraftChange; readonly validate: boolean }
  /** An unblocked draft whose condition to validate now holds (a credit note whose invoice was issued). */
  | { readonly kind: "VALIDATE"; readonly documentId: TaxDocumentRecord["documentId"]; readonly expectedVersion: number };

interface Decision {
  readonly profile: FiscalProfileRecord;
  readonly blocker: FiscalBlocker | null;
}

/** The profile version an invoice takes and whether it validates (saleProfileAt's choice judged by resolveFiscalTreatment). */
function invoiceDecision(capture: CaptureFactRecord, priced: TaxRuleSnapshot, saleProfile: FiscalProfileRecord | null, fallback: FiscalProfileRecord | null, issuer: FiscalIssuerRecord | null, taxPoint: UtcInstant): Decision | null {
  const profile = saleProfile ?? fallback;
  if (profile === null) return null;
  if (saleProfile === null) return { profile, blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" };
  if (profile.taxTreatment === "REVIEW_REQUIRED") return { profile, blocker: "FISCAL_TREATMENT_UNREVIEWED" };
  if (issuer === null) return { profile, blocker: "ISSUER_FACTS_UNCONFIRMED" };
  const decision = resolveFiscalTreatment({ profile, issuer, taxPoint, serviceCents: capture.allocation.serviceCents, priced });
  return { profile, blocker: decision.kind === "BLOCKED" ? decision.blocker : null };
}

export function planFiscalDocument(input: FiscalInput): FiscalPlan {
  switch (input.kind) {
    case "INVOICE": {
      const { capture } = input;
      if (input.existing !== null) return { kind: "NONE", reason: "ALREADY_DRAFTED" };
      if (capture.allocation.serviceCents + capture.allocation.taxCents === 0n) return { kind: "NONE", reason: "NOT_A_SALE" };
      if (capture.providerCompletedAt === undefined) return { kind: "NONE", reason: "NO_TAX_POINT" };
      const decision = invoiceDecision(capture, input.priced, input.saleProfile, input.currentProfile, input.issuer, capture.providerCompletedAt);
      if (decision === null) return { kind: "NONE", reason: "NO_PROFILE" };
      return {
        kind: "DRAFT",
        document: {
          agencyId: input.order.agencyId,
          orderId: input.order.orderId,
          captureId: capture.captureId,
          kind: "INVOICE",
          fiscalProfileId: decision.profile.profileId,
          issuerRef: decision.profile.operatorLegalRef,
          taxTreatment: decision.profile.taxTreatment,
          // the collected amounts: the capture's allocation (tax_documents_validation_guard)
          serviceCents: capture.allocation.serviceCents,
          taxCents: capture.allocation.taxCents,
          ...(decision.blocker !== null ? { blockedReason: decision.blocker } : {}),
        },
        validate: decision.blocker === null,
      };
    }
    case "CREDIT_NOTE": {
      const { refund, invoice } = input;
      if (refund.state !== "COMPLETED" || refund.approved === undefined) return { kind: "NONE", reason: "REFUND_NOT_COMPLETED" };
      if (!refund.approved.creditNoteRequired) return { kind: "NONE", reason: "NO_CREDIT_NOTE_REQUIRED" };
      if (invoice === null) return { kind: "NONE", reason: "AWAIT_INVOICE" };
      if (input.existing !== null) {
        const existing = input.existing;
        if (existing.state === "DRAFT" && existing.blockedReason === undefined && invoice.state === "ISSUED") return { kind: "VALIDATE", documentId: existing.documentId, expectedVersion: existing.version };
        return { kind: "NONE", reason: "ALREADY_DRAFTED" };
      }
      // exactly the corrected invoice's fiscal snapshot, judged at the sale's tax point (D-FISC-B5; B09-N5)
      const blocked = invoice.taxTreatment === "REVIEW_REQUIRED" ? (invoice.blockedReason ?? "FISCAL_TREATMENT_UNREVIEWED") : undefined;
      return {
        kind: "DRAFT",
        document: {
          agencyId: refund.agencyId,
          orderId: refund.orderId,
          captureId: refund.captureId,
          refundId: refund.refundId,
          kind: "CREDIT_NOTE",
          fiscalProfileId: invoice.fiscalProfileId,
          issuerRef: invoice.issuerRef,
          taxTreatment: invoice.taxTreatment,
          serviceCents: refund.approved.amounts.serviceCents,
          taxCents: refund.approved.amounts.taxCents,
          correctsDocumentId: invoice.documentId,
          ...(blocked !== undefined ? { blockedReason: blocked } : {}),
        },
        validate: blocked === undefined && invoice.state === "ISSUED",
      };
    }
    case "REEVALUATE": {
      const { draft } = input;
      if (draft.state !== "DRAFT") return { kind: "NONE", reason: "NOT_A_DRAFT" };
      let change: RedraftChange;
      if (draft.kind === "INVOICE") {
        if (input.capture.providerCompletedAt === undefined) return { kind: "NONE", reason: "NO_TAX_POINT" };
        // the draft's own version stays the fallback: a document is never re-pointed at nothing
        const decision = invoiceDecision(input.capture, input.priced, input.saleProfile, null, input.issuer, input.capture.providerCompletedAt);
        if (decision === null) {
          if (draft.blockedReason === "FISCAL_PROFILE_NOT_EFFECTIVE") return { kind: "NONE", reason: "UNCHANGED" };
          change = { fiscalProfileId: draft.fiscalProfileId, issuerRef: draft.issuerRef, taxTreatment: draft.taxTreatment, taxCents: draft.taxCents, blockedReason: "FISCAL_PROFILE_NOT_EFFECTIVE" };
        } else {
          change = { fiscalProfileId: decision.profile.profileId, issuerRef: decision.profile.operatorLegalRef, taxTreatment: decision.profile.taxTreatment, taxCents: input.capture.allocation.taxCents, blockedReason: decision.blocker };
        }
      } else if (draft.kind === "CREDIT_NOTE") {
        const invoice = input.invoice;
        if (invoice === null) return { kind: "NONE", reason: "AWAIT_INVOICE" };
        const blocked = invoice.taxTreatment === "REVIEW_REQUIRED" ? (invoice.blockedReason ?? "FISCAL_TREATMENT_UNREVIEWED") : null;
        change = { fiscalProfileId: invoice.fiscalProfileId, issuerRef: invoice.issuerRef, taxTreatment: invoice.taxTreatment, taxCents: draft.taxCents, blockedReason: blocked };
        const same = change.fiscalProfileId === draft.fiscalProfileId && change.issuerRef === draft.issuerRef && change.taxTreatment === draft.taxTreatment && (change.blockedReason ?? undefined) === draft.blockedReason;
        if (same) return blocked === null && invoice.state === "ISSUED" ? { kind: "VALIDATE", documentId: draft.documentId, expectedVersion: draft.version } : { kind: "NONE", reason: "UNCHANGED" };
        return { kind: "REDRAFT", documentId: draft.documentId, expectedVersion: draft.version, change, validate: blocked === null && invoice.state === "ISSUED" };
      } else {
        // a debit note has no basis in any flow of this package (Q-B09-18)
        return { kind: "NONE", reason: "NOT_A_DRAFT" };
      }
      const same = change.fiscalProfileId === draft.fiscalProfileId && change.issuerRef === draft.issuerRef && change.taxTreatment === draft.taxTreatment && change.taxCents === draft.taxCents && (change.blockedReason ?? undefined) === draft.blockedReason;
      if (same) return change.blockedReason === null ? { kind: "VALIDATE", documentId: draft.documentId, expectedVersion: draft.version } : { kind: "NONE", reason: "UNCHANGED" };
      return { kind: "REDRAFT", documentId: draft.documentId, expectedVersion: draft.version, change, validate: change.blockedReason === null };
    }
  }
}

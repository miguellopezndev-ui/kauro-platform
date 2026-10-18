// Inputs in the platform's bindings for the assembler's tests (order 6; docs/design/B13-report-inputs.md): a quote whose recorded hash is
// KAURO_QUOTE_TERMS_V1 of its preimage, the agency's acceptance of its terms version, a fiscal issuer whose legal identity hash is the
// SHA-256 of a KAURO_LEGAL_IDENTITY_V1 document, the agency's branding version, the subject's audit findings and the approval's disclosure
// set — every value built the way the platform's records are, and every name and number plainly synthetic (TEST, never an identity).
// The control plane's tests read the same bindings from a real PostgreSQL 17 (apps/control/test/b13-report-inputs.test.ts).
import { disclosuresHashOf } from "@kauro/application";
import { rawDigest, type RowCounts } from "@kauro/contracts";
import { legalIdentityBytesOf, quoteTermsHash, type LegalIdentity, type QuoteTermsPreimage } from "@kauro/domain";
import type { AuthorizedReportInputs, QuoteTerms, ReportScope, ReportSubject } from "../../src/index.js";
import { sha } from "./report-rig.js";

/** A synthetic identity: every field says it is a test's, none is anyone's. */
export const TEST_IDENTITY: LegalIdentity = Object.freeze({
  legalName: "Synthetic Test Issuer S.A.S.",
  entityType: "TEST ENTITY",
  jurisdiction: "CO",
  taxId: "TEST-TAX-000000000-0",
  commercialRegistrationId: "TEST-REG-000000",
  registeredAddress: "Synthetic Test Address 1",
});

const uuid = (seed: string): string => {
  const h = sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface PlatformParts {
  readonly subject: ReportSubject;
  readonly preimage: QuoteTermsPreimage;
  readonly identity: Uint8Array;
  readonly items: readonly string[];
}

export function platformPartsOf(scope: ReportScope, counts: RowCounts): PlatformParts {
  const subject: ReportSubject = {
    planId: uuid(`plan-${scope.jobId}`),
    planHash: sha(`plan-hash-${scope.jobId}`),
    approvalId: uuid(`approval-${scope.jobId}`),
    revisionHash: sha(`revision-${scope.jobId}`),
    targetContractHash: sha(`target-${scope.jobId}`),
    validationReceiptHash: sha(`receipt-${scope.jobId}`),
  };
  const preimage: QuoteTermsPreimage = {
    quoteId: uuid(`quote-${scope.jobId}`),
    agencyId: scope.agencyId,
    projectId: scope.projectId,
    planId: subject.planId,
    approvalId: subject.approvalId,
    planHash: subject.planHash as QuoteTermsPreimage["planHash"],
    revisionHash: subject.revisionHash as QuoteTermsPreimage["revisionHash"],
    targetContractHash: subject.targetContractHash as QuoteTermsPreimage["targetContractHash"],
    mode: "HUBSPOT",
    billableUnits: counts.billableSourceUnits,
    pricePolicyVersion: "R2-INITIAL",
    discountPolicyVersion: "R2-INITIAL",
    eligibilitySnapshotId: uuid(`snapshot-${scope.jobId}`),
    baseServiceCents: "49000" as QuoteTermsPreimage["baseServiceCents"],
    discountBps: 2500,
    discountCents: "12250" as QuoteTermsPreimage["discountCents"],
    serviceCents: "36750" as QuoteTermsPreimage["serviceCents"],
    fiscalProfileId: uuid(`profile-${scope.agencyId}`),
    issuerRef: uuid("issuer"),
    taxTreatment: "EXEMPT_EXPORT",
    taxRule: "ZERO_REVIEWED",
    taxRateBps: 0,
    taxCents: "0" as QuoteTermsPreimage["taxCents"],
    totalCents: "36750" as QuoteTermsPreimage["totalCents"],
    currency: "USD",
    issuedAt: "2026-10-01T12:00:00.123456Z" as QuoteTermsPreimage["issuedAt"],
    expiresAt: "2026-10-15T12:00:00.123456Z" as QuoteTermsPreimage["expiresAt"],
    sourceAvailableUntil: "2026-10-08T12:00:00.123456Z" as QuoteTermsPreimage["sourceAvailableUntil"],
    termsVersion: "TERMS-2026-01",
  };
  return { subject, preimage, identity: legalIdentityBytesOf(TEST_IDENTITY), items: ["SET:Contact.email:19", "CLEAR:Contact.phone:19"] };
}

/** The platform's inputs for `scope`, every binding consistent with the others (the record EXECUTED_LOCAL: a test of the assembler). */
export function platformInputsOf(scope: ReportScope, record: { readonly expectedManifestSha256: string; readonly counts: RowCounts }, parts: PlatformParts = platformPartsOf(scope, record.counts)): AuthorizedReportInputs {
  const { subject, preimage, identity, items } = parts;
  const c = record.counts;
  const terms: QuoteTerms = {
    binding: "QUOTE_TERMS_V1",
    termsVersion: preimage.termsVersion,
    termsSha256: quoteTermsHash(preimage),
    quoteState: "ACCEPTED_FOR_CHECKOUT",
    preimage,
    acceptance: { version: preimage.termsVersion, documentHash: sha("terms-document-TERMS-2026-01"), acceptedAt: "2026-09-30T08:00:00.000000Z" },
    issuer: { issuerRef: preimage.issuerRef, jurisdiction: "CO", legalIdentityHash: rawDigest(identity), legalFactStatus: "PROFESSIONALLY_CONFIRMED", identity },
  };
  return {
    evidenceClass: "EXECUTED_LOCAL",
    scope,
    subject,
    expectedManifestSha256: record.expectedManifestSha256,
    quote: { quoteId: preimage.quoteId, billableSourceUnits: preimage.billableUnits },
    privacyClass: "SECURE_DETAIL",
    branding: { binding: "AGENCY_BRANDING_V1", agencyId: scope.agencyId, version: 2, displayName: "Synthetic Test Agency", recordedAt: "2026-09-01T00:00:00.000000Z", logo: null },
    logo: null,
    terms,
    countFacts: {
      populations: { physicalSourceRows: c.physicalSourceRows, logicalSourceRecords: c.logicalSourceRecords, billableSourceUnits: c.billableSourceUnits, associationEdges: c.associationEdges },
      receiptCounts: { ...c },
    },
    findings: { binding: "AUDIT_FINDINGS_V1", auditId: uuid(`audit-${scope.jobId}`), auditState: "NEEDS_DECISION", codes: ["AGENCY_DECISION_REQUIRED"] },
    materialDecisions: {
      binding: "APPROVAL_DISCLOSURES_V1",
      approvalId: subject.approvalId,
      planHash: subject.planHash,
      receiptHash: subject.validationReceiptHash,
      disclosuresHash: disclosuresHashOf(subject.planHash, subject.validationReceiptHash, items),
      items,
    },
  };
}

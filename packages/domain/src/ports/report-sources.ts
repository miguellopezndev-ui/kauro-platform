/**
 * The platform's records a B13 report is made from (order 6; docs/design/B13-report-inputs.md): what the control plane reads, in a
 * SYSTEM unit of work bound to the job's agency, for one attempt's report. Every member is a record as the database holds it, or null
 * when no such record is visible; nothing here is derived, defaulted or checked — the report's assembler (`@kauro/data-plane`
 * assembleReportFacts) verifies each binding and refuses what it cannot verify, so an absent record is never read as an empty one.
 *
 * And the agency's branding versions (registry CMD008 "Create a new branding version for future reports while preserving already
 * delivered artifact identity"; migration 0095): append-only, numbered from 1 per agency, a report of a job naming the version in force
 * when the job was queued, bound once per job (report_branding_bindings) so that every read and attempt names the same one.
 */
import type { QuoteTermsPreimage } from "../commerce/pricing.js";
import type { LegalFactStatus } from "../commerce/records.js";
import type { PlanBody } from "../model/aggregates.js";
import type { AgencyId, MembershipId } from "../model/ids.js";

/** Whose report: the four identifiers the attempt's capability binds. */
export interface ReportFactsScope {
  readonly agencyId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly attemptId: string;
}

export interface RecordedReportFacts {
  readonly scope: ReportFactsScope;
  /** The job's purchased and approved subject, exactly as its row binds it, and the instant it was queued (exact, microseconds). */
  readonly job: {
    readonly planId: string;
    readonly planHash: string;
    readonly approvalId: string;
    readonly revisionHash: string;
    readonly targetContractHash: string;
    readonly validationReceiptHash: string;
    readonly authorizationId: string;
    readonly queuedAt: string;
  };
  readonly attempt: { readonly state: string; readonly ordinal: number };
  /** The VALID validation receipt the job binds (the job's whole subject), or null. */
  readonly receipt: { readonly receiptHash: string; readonly artifactEvidenceHash: string; readonly physicalSourceRows: number | null } | null;
  /** The quote the job's commercial authorization names: its state, its recorded terms hash and every member of its terms preimage. */
  readonly quote: { readonly state: string; readonly termsHash: string; readonly preimage: QuoteTermsPreimage } | null;
  /** The agency's latest acceptance of the quote's terms version at or before the quote's issuance (CMD002), or null. */
  readonly termsAcceptance: { readonly version: string; readonly documentHash: string; readonly acceptedAt: string } | null;
  /** The fiscal issuer the quote names (its `issuerRef`). */
  readonly issuer: { readonly issuerRef: string; readonly jurisdiction: string; readonly legalIdentityHash: string; readonly legalFactStatus: LegalFactStatus } | null;
  /** The recorded document whose SHA-256 is the issuer's legal identity hash, or null while none is recorded. */
  readonly legalIdentity: Uint8Array | null;
  /** The job's branding version: bound once per job, at its first read, to the version in force when it was queued; null when it had none. */
  readonly branding: BrandingVersionRecord | null;
  /** The one audit of the job's subject (its revision and target contract) and the findings it recorded. */
  readonly audit: { readonly auditId: string; readonly state: string; readonly findingCodes: readonly string[] } | null;
  /** The job's approval and the hash of the disclosure set it was granted over (CMD025). */
  readonly approval: { readonly approvalId: string; readonly planHash: string; readonly receiptHash: string; readonly disclosuresHash: string } | null;
  /** The approved plan's body, from which the disclosure set is composed again. */
  readonly plan: { readonly planId: string; readonly bodyHash: string; readonly body: PlanBody } | null;
}

export interface ReportFactsReader {
  /** The records of the attempt's report, or null when the attempt is not one of the scope's job, project and agency. */
  read(scope: ReportFactsScope): Promise<RecordedReportFacts | null>;
}

/** One branding version of an agency as recorded: its number, its display name and the database instant it was recorded at (exact). */
export interface BrandingVersionRecord {
  readonly agencyId: string;
  readonly version: number;
  readonly displayName: string;
  readonly recordedAt: string;
}

export interface NewBrandingVersion {
  readonly agencyId: AgencyId;
  /** The agency's ACTIVE OWNER or ADMIN membership of the session's person (MANAGE_BRANDING). */
  readonly recordedByMembershipId: MembershipId;
  readonly displayName: string;
}

export interface BrandingVersionRepository {
  /** Records the agency's next version (the database numbers it and stamps the instant); refuses a name a report could not print. */
  record(input: NewBrandingVersion): Promise<BrandingVersionRecord>;
  /** The agency's versions, oldest first. */
  versionsOf(agencyId: AgencyId): Promise<readonly BrandingVersionRecord[]>;
}

/**
 * The platform's facts for one report, taken from authorized inputs and checked (B13 x B08; docs/design/B13-report-delivery.md §3,
 * docs/design/B13-report-inputs.md).
 *
 * `buildReportModel` takes PlatformFacts as untrusted data; this module is what makes them the platform's. A `ReportInputsPort`
 * answers, for one attempt's scope, only what the platform recorded — and every fact that another record can vouch for arrives with
 * that record, so it is verified here rather than believed:
 *
 * - The terms are the frozen quote's (`terms_version`, `terms_hash`). The hash is KAURO_QUOTE_TERMS_V1 over the quote's own preimage,
 *   which is recomputed here from the recorded members; the preimage names the job's subject, the terms version the agency accepted and
 *   the fiscal issuer (`issuerRef`).
 * - The issuer is read from that issuer's legal identity document (KAURO_LEGAL_IDENTITY_V1), whose SHA-256 must be the issuer's
 *   recorded `legal_identity_hash`: the issuer cannot differ from the one the accepted terms name (R2-070), and no brand, fixture or
 *   display name can stand in for it.
 * - The material decisions are the disclosure set of the job's approval, composed again from the plan and the receipt and held to the
 *   approval's recorded `disclosures_hash`; the findings are those the subject's audit recorded; the branding is the agency's version
 *   in force when the job was queued; the privacy class is the audience of a B08 package (the package's agency, CMD038).
 * - `countsBinding` is BOUND or the report is not produced: RowCounts come from `deliveryRowCountsOf` over the platform's
 *   populations and the bound receipt, the same rule the publication applies.
 * - The report's identifiers are functions of the attempt's UUIDs, not free text: `rpt-<jobId>` and `pkg-<attemptId>`.
 *
 * A fact that is absent is null, and null is refused with its own code: nothing here turns an unknown into an empty list, a zero or a
 * default. The simulator's bindings (`SIMULATED`, `REPORT_TERMS_SNAPSHOT_V1`) are accepted only from inputs that say SIMULATED, and the
 * stage refuses SIMULATED inputs unless its composition admits them (tests only).
 *
 * KAURO_REPORT_TERMS_SNAPSHOT_V1 and the quote's terms hash name different documents: the snapshot hashes {termsVersion, issuer}, the
 * quote's hash its whole commercial preimage. No platform record holds a snapshot, and none can be made whose raw SHA-256 is a quote's
 * terms hash, so the snapshot binding is kept for the simulator only and the platform's binding is QUOTE_TERMS_V1 (design §3.2).
 */
import { disclosuresHashOf } from "@kauro/application";
import { canonicalBytes, isSha256Hex, parseCanonical, rawDigest } from "@kauro/contracts";
import { deliveryRowCountsOf, quoteTermsHash, readLegalIdentity, type DeliveryCountFacts, type LegalFactStatus, type QuoteTermsPreimage } from "@kauro/domain";
import type { Branding, LegalIssuer, PlatformFacts, PrivacyClass } from "@kauro/reports";
import { ReportStageError } from "./errors.js";

/** Whose report: the four identifiers the attempt's capability already binds. */
export interface ReportScope {
  readonly agencyId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly attemptId: string;
}

export const reportIdOf = (scope: ReportScope): string => `rpt-${scope.jobId}`;
export const reportPackageIdOf = (scope: ReportScope): string => `pkg-${scope.attemptId}`;

export const REPORT_INPUTS_EVIDENCE_CLASSES = ["SIMULATED", "EXECUTED_LOCAL", "EXECUTED_PROVIDER"] as const;
export type ReportInputsEvidenceClass = (typeof REPORT_INPUTS_EVIDENCE_CLASSES)[number];

/**
 * The privacy class of every report a B08 package carries. Its audience is the package's agency: CMD038 grants the delivery copies
 * to members of that agency only (AGENCY_READER), never to a seller or another agency, and the package itself holds the agency's
 * records and their traceability. SECURE_DETAIL is the class of that audience (source file names included); INTERNAL_EVIDENCE is
 * Kauro's own and AGENCY_SUMMARY a summary for wider circulation, neither of which this delivery is.
 */
export const B08_PACKAGE_REPORT_PRIVACY_CLASS: PrivacyClass = "SECURE_DETAIL";

/** The legal fact statuses an issuer's identity may be printed under (the statuses 0013 requires of a QUALIFIED route). */
export const PRINTABLE_LEGAL_FACT_STATUSES: readonly LegalFactStatus[] = ["OBSERVED", "PROFESSIONALLY_CONFIRMED"];

/** The quote state of a purchase that governs its delivery (a paid quote stays ACCEPTED_FOR_CHECKOUT while its entitlement lives). */
export const QUOTE_IN_FORCE = "ACCEPTED_FOR_CHECKOUT";

/** The audit states a plan of the subject can come from: the system's draft (DRAFT_READY) or the agency's decisions (NEEDS_DECISION). */
export const AUDIT_STATES_WITH_PLANS: readonly string[] = ["DRAFT_READY", "NEEDS_DECISION"];

/** The job's purchased and approved subject, as its row binds it. */
export interface ReportSubject {
  readonly planId: string;
  readonly planHash: string;
  readonly approvalId: string;
  readonly revisionHash: string;
  readonly targetContractHash: string;
  readonly validationReceiptHash: string;
}

/** The simulator's terms: a snapshot of {termsVersion, issuer} whose raw SHA-256 is the recorded hash. SIMULATED inputs only. */
export interface SnapshotTerms {
  readonly binding: "REPORT_TERMS_SNAPSHOT_V1";
  readonly termsVersion: string;
  readonly termsSha256: string;
  readonly snapshot: Uint8Array;
}

/** The platform's terms: the frozen quote, its recorded hash and the records its preimage names. */
export interface QuoteTerms {
  readonly binding: "QUOTE_TERMS_V1";
  readonly termsVersion: string;
  /** The quote's recorded `terms_hash`. */
  readonly termsSha256: string;
  readonly quoteState: string;
  /** Every member of the quote's KAURO_QUOTE_TERMS_V1 preimage, as recorded. */
  readonly preimage: QuoteTermsPreimage;
  /** The agency's acceptance of the terms version at or before the quote's issuance (CMD002), or null. */
  readonly acceptance: { readonly version: string; readonly documentHash: string; readonly acceptedAt: string } | null;
  /** The issuer the preimage names and the document its legal identity hash is the SHA-256 of (null while none is recorded). */
  readonly issuer: { readonly issuerRef: string; readonly jurisdiction: string; readonly legalIdentityHash: string; readonly legalFactStatus: LegalFactStatus; readonly identity: Uint8Array | null } | null;
}

export type ReportBrandingInputs =
  | { readonly binding: "SIMULATED"; readonly branding: Branding }
  /** The agency's branding version in force when the job was queued (migration 0095; no logo: the stored-logo pipeline is CMD008's). */
  | { readonly binding: "AGENCY_BRANDING_V1"; readonly agencyId: string; readonly version: number; readonly displayName: string; readonly recordedAt: string };

export type ReportFindingsInputs =
  | { readonly binding: "SIMULATED"; readonly ids: readonly string[] }
  /** The findings the audit of the job's subject recorded with its edge (an empty list is the audit's own record of none). */
  | { readonly binding: "AUDIT_FINDINGS_V1"; readonly auditId: string; readonly auditState: string; readonly codes: readonly string[] };

export type ReportDecisionsInputs =
  | { readonly binding: "SIMULATED"; readonly ids: readonly string[] }
  /** The disclosure set of the job's approval, composed from its plan and receipt, and the hash the approval recorded. */
  | { readonly binding: "APPROVAL_DISCLOSURES_V1"; readonly approvalId: string; readonly planHash: string; readonly receiptHash: string; readonly disclosuresHash: string; readonly items: readonly string[] };

export interface AuthorizedReportInputs {
  /** What produced these inputs. A simulator says SIMULATED; nothing here lets one be mistaken for the platform's records. */
  readonly evidenceClass: ReportInputsEvidenceClass;
  /** The scope the inputs were read for; they are refused for any other. */
  readonly scope: ReportScope;
  /** The job's subject (required of the platform's inputs: every binding below is held to it). */
  readonly subject: ReportSubject | null;
  /** The manifest SHA-256 the platform's validation receipt bound (`artifactEvidenceHash`): the package this job must deliver. */
  readonly expectedManifestSha256: string;
  /** The frozen quote the job's commercial authorization names (null when it is not visible). */
  readonly quote: { readonly quoteId: string; readonly billableSourceUnits: number } | null;
  readonly privacyClass: PrivacyClass;
  readonly branding: ReportBrandingInputs | null;
  /** The stored logo's bytes when the branding names one. */
  readonly logo: Uint8Array | null;
  readonly terms: SnapshotTerms | QuoteTerms | null;
  /** The sealed revision's populations and the bound receipt's counts, as the publication reads them. */
  readonly countFacts: DeliveryCountFacts | null;
  readonly findings: ReportFindingsInputs | null;
  readonly materialDecisions: ReportDecisionsInputs | null;
}

export interface ReportInputsPort {
  /** The platform's recorded inputs for this attempt's report, or null when it has none. Throws only on an infrastructure failure. */
  read(scope: ReportScope): Promise<AuthorizedReportInputs | null>;
}

// --- the simulator's terms snapshot ---------------------------------------------------------------------------------------------

export const TERMS_SNAPSHOT_DOMAIN = "KAURO_REPORT_TERMS_SNAPSHOT_V1";

/** The canonical bytes of a terms snapshot (the simulator's binding; see the header). */
export function termsSnapshotBytesOf(termsVersion: string, issuer: LegalIssuer): Uint8Array {
  const { legalName, jurisdiction, registrationId } = issuer;
  return canonicalBytes({ domain: TERMS_SNAPSHOT_DOMAIN, version: 1, payload: { termsVersion, issuer: { legalName, jurisdiction, registrationId } } });
}

export type TermsSnapshotReading =
  | { readonly ok: true; readonly termsVersion: string; readonly issuer: LegalIssuer; readonly sha256: string }
  | { readonly ok: false; readonly problem: string };

const closed = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();

/** Reads a snapshot back from its bytes: the closed wrapper, the closed payload and issuer, and nothing else. */
export function readTermsSnapshot(bytes: Uint8Array): TermsSnapshotReading {
  const refuse = (problem: string): TermsSnapshotReading => ({ ok: false, problem });
  let doc: unknown;
  try {
    doc = parseCanonical(Buffer.from(bytes).toString("utf8"));
  } catch {
    return refuse("NOT_CANONICAL");
  }
  if (!closed(doc, ["domain", "payload", "version"]) || doc["domain"] !== TERMS_SNAPSHOT_DOMAIN || doc["version"] !== 1) return refuse("NOT_A_TERMS_SNAPSHOT");
  const payload = doc["payload"];
  if (!closed(payload, ["issuer", "termsVersion"])) return refuse("PAYLOAD_NOT_CLOSED");
  const issuer = payload["issuer"];
  if (!closed(issuer, ["jurisdiction", "legalName", "registrationId"])) return refuse("ISSUER_NOT_CLOSED");
  const { legalName, jurisdiction, registrationId } = issuer;
  if (typeof payload["termsVersion"] !== "string" || typeof legalName !== "string" || typeof jurisdiction !== "string" || typeof registrationId !== "string") return refuse("FIELD_NOT_TEXT");
  // the bytes must be exactly the canonical form of what they say (no second spelling of the same snapshot)
  const again = termsSnapshotBytesOf(payload["termsVersion"], { legalName, jurisdiction, registrationId });
  if (Buffer.compare(Buffer.from(again), Buffer.from(bytes)) !== 0) return refuse("NOT_THE_CANONICAL_FORM");
  return { ok: true, termsVersion: payload["termsVersion"], issuer: { legalName, jurisdiction, registrationId }, sha256: rawDigest(bytes) };
}

// --- verification of each binding -----------------------------------------------------------------------------------------------

const sameScope = (a: ReportScope, b: ReportScope): boolean => a.agencyId === b.agencyId && a.projectId === b.projectId && a.jobId === b.jobId && a.attemptId === b.attemptId;

/** The terms version, hash and issuer of the simulator's snapshot. */
function snapshotTermsOf(terms: SnapshotTerms): { readonly termsVersion: string; readonly termsSha256: string; readonly issuer: LegalIssuer } {
  const read = readTermsSnapshot(terms.snapshot);
  if (!read.ok) throw new ReportStageError("TERMS_UNVERIFIABLE", `the terms snapshot is not readable (${read.problem})`);
  if (read.termsVersion !== terms.termsVersion) throw new ReportStageError("TERMS_UNVERIFIABLE", "the snapshot is of another terms version than the one the platform recorded");
  if (!isSha256Hex(terms.termsSha256) || read.sha256 !== terms.termsSha256) throw new ReportStageError("TERMS_UNVERIFIABLE", "the snapshot is not the document whose hash the platform recorded");
  return { termsVersion: read.termsVersion, termsSha256: read.sha256, issuer: read.issuer };
}

/**
 * The quote's terms, verified: the recorded hash is KAURO_QUOTE_TERMS_V1 of the recorded preimage, the preimage is of this scope's
 * agency and project and of the job's own subject, the quote governs the purchase, the agency accepted that terms version before the
 * quote, and the issuer the preimage names is identified by the document its recorded hash is the SHA-256 of.
 */
function quoteTermsOf(scope: ReportScope, subject: ReportSubject, quote: NonNullable<AuthorizedReportInputs["quote"]>, terms: QuoteTerms): { readonly termsVersion: string; readonly termsSha256: string; readonly issuer: LegalIssuer } {
  const p = terms.preimage;
  if (!isSha256Hex(terms.termsSha256)) throw new ReportStageError("FACTS_MALFORMED", "the quote's terms hash is not a SHA-256");
  let recomputed: string;
  try {
    recomputed = quoteTermsHash(p);
  } catch {
    throw new ReportStageError("TERMS_UNVERIFIABLE", "the quote's recorded terms are not a canonical KAURO_QUOTE_TERMS_V1 preimage");
  }
  if (recomputed !== terms.termsSha256) throw new ReportStageError("TERMS_UNVERIFIABLE", "the quote's recorded members do not hash to its recorded terms hash (KAURO_QUOTE_TERMS_V1)");
  if (p.termsVersion !== terms.termsVersion) throw new ReportStageError("TERMS_UNVERIFIABLE", "the quote's terms preimage names another terms version than the one recorded");
  if (p.agencyId !== scope.agencyId || p.projectId !== scope.projectId) throw new ReportStageError("FACTS_FOREIGN_SCOPE", "the quote is of another agency or project");
  if (p.planId !== subject.planId || p.approvalId !== subject.approvalId || p.planHash !== subject.planHash || p.revisionHash !== subject.revisionHash || p.targetContractHash !== subject.targetContractHash) {
    throw new ReportStageError("FACTS_FOREIGN_SCOPE", "the quote prices another plan, approval, source or target than the job's");
  }
  if (p.quoteId !== quote.quoteId || p.billableUnits !== quote.billableSourceUnits) throw new ReportStageError("FACTS_FOREIGN_SCOPE", "the quote the inputs name is not the quote whose terms they carry");
  if (terms.quoteState !== QUOTE_IN_FORCE) throw new ReportStageError("QUOTE_NOT_IN_FORCE", `the quote is ${terms.quoteState}: it no longer governs a purchase`);
  const accepted = terms.acceptance;
  if (accepted === null) throw new ReportStageError("TERMS_UNAVAILABLE", "the agency recorded no acceptance of the quote's terms version before the quote");
  if (accepted.version !== terms.termsVersion || !isSha256Hex(accepted.documentHash) || !(Date.parse(accepted.acceptedAt) <= Date.parse(p.issuedAt))) {
    throw new ReportStageError("TERMS_UNVERIFIABLE", "the agency's acceptance is of another terms version or later than the quote");
  }
  const issuer = terms.issuer;
  if (issuer === null) throw new ReportStageError("ISSUER_UNAVAILABLE", "the fiscal issuer the quote's terms name is not recorded");
  if (issuer.issuerRef !== p.issuerRef) throw new ReportStageError("ISSUER_UNVERIFIABLE", "the issuer is not the one the quote's terms name");
  if (issuer.identity === null) throw new ReportStageError("ISSUER_UNAVAILABLE", "no legal identity document is recorded for the issuer the quote's terms name");
  if (!isSha256Hex(issuer.legalIdentityHash) || rawDigest(issuer.identity) !== issuer.legalIdentityHash) throw new ReportStageError("ISSUER_UNVERIFIABLE", "the legal identity document is not the one whose hash the issuer records");
  const read = readLegalIdentity(issuer.identity);
  if (!read.ok) throw new ReportStageError("ISSUER_UNVERIFIABLE", `the legal identity document is not a complete identity (${read.problem})`);
  if (read.identity.jurisdiction !== issuer.jurisdiction) throw new ReportStageError("ISSUER_UNVERIFIABLE", "the legal identity is of another jurisdiction than the issuer's");
  if (!PRINTABLE_LEGAL_FACT_STATUSES.includes(issuer.legalFactStatus)) throw new ReportStageError("ISSUER_UNVERIFIABLE", `the issuer's legal facts are ${issuer.legalFactStatus}, not observed or professionally confirmed`);
  // the report's issuer line: the registered name, the registering state and the tax identification number
  return { termsVersion: p.termsVersion, termsSha256: recomputed, issuer: { legalName: read.identity.legalName, jurisdiction: read.identity.jurisdiction, registrationId: read.identity.taxId } };
}

const AGENCY_BRANDING_VERSION = (version: number): string => `agency-branding-v${version}`;

function brandingOf(scope: ReportScope, inputs: AuthorizedReportInputs, platform: boolean): Branding {
  const b = inputs.branding;
  if (b === null) throw new ReportStageError("BRANDING_UNAVAILABLE", "the agency had no branding version when the job was queued");
  if (b.binding === "SIMULATED") {
    if (platform) throw new ReportStageError("BRANDING_UNVERIFIABLE", "a simulated branding is not the platform's record");
    return b.branding;
  }
  if (b.agencyId !== scope.agencyId) throw new ReportStageError("FACTS_FOREIGN_SCOPE", "the branding is another agency's");
  if (!Number.isSafeInteger(b.version) || b.version < 1) throw new ReportStageError("FACTS_MALFORMED", "a branding version is a positive integer");
  if (inputs.logo !== null) throw new ReportStageError("BRANDING_UNVERIFIABLE", "an agency branding version names no logo");
  return { version: AGENCY_BRANDING_VERSION(b.version), displayName: b.displayName, logo: null };
}

function findingIdsOf(inputs: AuthorizedReportInputs, platform: boolean): readonly string[] {
  const f = inputs.findings;
  if (f === null) throw new ReportStageError("FINDINGS_UNAVAILABLE", "no audit of the job's subject recorded its findings");
  if (f.binding === "SIMULATED") {
    if (platform) throw new ReportStageError("FINDINGS_UNVERIFIABLE", "simulated findings are not the platform's record");
    return [...f.ids];
  }
  if (!AUDIT_STATES_WITH_PLANS.includes(f.auditState)) throw new ReportStageError("FINDINGS_UNVERIFIABLE", `the subject's audit is ${f.auditState}: no plan is made from such an audit`);
  // the audit's findings as it recorded them, each once
  return [...new Set(f.codes)];
}

function decisionIdsOf(subject: ReportSubject | null, inputs: AuthorizedReportInputs, platform: boolean): readonly string[] {
  const d = inputs.materialDecisions;
  if (d === null) throw new ReportStageError("DECISIONS_UNAVAILABLE", "the job's approval or the disclosure set it was granted over is not recorded");
  if (d.binding === "SIMULATED") {
    if (platform) throw new ReportStageError("DECISIONS_UNVERIFIABLE", "simulated decisions are not the platform's record");
    return [...d.ids];
  }
  if (subject === null || d.approvalId !== subject.approvalId || d.planHash !== subject.planHash || d.receiptHash !== subject.validationReceiptHash) {
    throw new ReportStageError("FACTS_FOREIGN_SCOPE", "the disclosure set is of another approval, plan or receipt than the job's");
  }
  if (!isSha256Hex(d.disclosuresHash) || disclosuresHashOf(d.planHash, d.receiptHash, d.items) !== d.disclosuresHash) {
    throw new ReportStageError("DECISIONS_UNVERIFIABLE", "the disclosure set composed from the plan and the receipt is not the one the approval was granted over");
  }
  return [...d.items];
}

// --- assembly -------------------------------------------------------------------------------------------------------------------

/**
 * The PlatformFacts of the attempt's report, or a refusal naming why none can be made. Never returns facts with `declaredCounts`
 * null, an issuer the terms do not name, a fact the platform did not record, or inputs read for another scope.
 */
export function assembleReportFacts(scope: ReportScope, inputs: AuthorizedReportInputs | null, rendererVersion: string): PlatformFacts {
  if (inputs === null) throw new ReportStageError("FACTS_UNAVAILABLE", "the platform has no recorded inputs for this attempt's report");
  if (!sameScope(inputs.scope, scope)) throw new ReportStageError("FACTS_FOREIGN_SCOPE", "the inputs were read for another agency, project, job or attempt");
  const platform = inputs.evidenceClass !== "SIMULATED";
  const subject = inputs.subject;
  if (platform && subject === null) throw new ReportStageError("FACTS_UNAVAILABLE", "the platform's inputs name no job subject");
  if (!isSha256Hex(inputs.expectedManifestSha256)) throw new ReportStageError("FACTS_MALFORMED", "the receipt's manifest hash is not a SHA-256");
  if (platform && inputs.privacyClass !== B08_PACKAGE_REPORT_PRIVACY_CLASS) {
    throw new ReportStageError("PRIVACY_UNAUTHORIZED", `a B08 package's report is for its agency (${B08_PACKAGE_REPORT_PRIVACY_CLASS}), not ${inputs.privacyClass}`);
  }

  const quote = inputs.quote;
  if (quote === null) throw new ReportStageError("QUOTE_UNAVAILABLE", "the platform has no frozen quote for the job's purchase");
  if (inputs.terms === null) throw new ReportStageError("TERMS_UNAVAILABLE", "no recorded terms name the issuer");
  let terms: { readonly termsVersion: string; readonly termsSha256: string; readonly issuer: LegalIssuer };
  if (inputs.terms.binding === "REPORT_TERMS_SNAPSHOT_V1") {
    if (platform) throw new ReportStageError("TERMS_UNVERIFIABLE", "a terms snapshot is the simulator's binding; the platform's terms are the quote's");
    terms = snapshotTermsOf(inputs.terms);
  } else {
    if (subject === null) throw new ReportStageError("FACTS_UNAVAILABLE", "the quote's terms are verified against the job's subject, and the inputs name none");
    terms = quoteTermsOf(scope, subject, quote, inputs.terms);
  }

  if (inputs.countFacts === null) throw new ReportStageError("COUNTS_UNAVAILABLE", "the platform has no populations or receipt counts for this package");
  const counted = deliveryRowCountsOf(inputs.countFacts);
  if (counted.kind === "REFUSED") {
    const code = counted.reason === "COUNTS_MISMATCH" ? "COUNTS_MISMATCH" : counted.reason === "COUNTS_UNRESOLVED" ? "COUNTS_UNRESOLVED" : "COUNTS_UNAVAILABLE";
    throw new ReportStageError(code, "the platform's populations and the bound receipt do not support RowCounts");
  }

  return {
    reportId: reportIdOf(scope),
    packageId: reportPackageIdOf(scope),
    expectedManifestSha256: inputs.expectedManifestSha256,
    privacyClass: inputs.privacyClass,
    billableSourceUnits: quote.billableSourceUnits,
    quoteId: quote.quoteId,
    branding: brandingOf(scope, inputs, platform),
    termsVersion: terms.termsVersion,
    termsSha256: terms.termsSha256,
    issuer: terms.issuer,
    findingIds: findingIdsOf(inputs, platform),
    materialDecisionIds: decisionIdsOf(subject, inputs, platform),
    rendererVersion,
    declaredCounts: counted.counts,
  };
}

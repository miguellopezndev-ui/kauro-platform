/**
 * The platform's facts for one report, taken from authorized inputs and checked (B13 x B08; docs/design/B13-report-delivery.md §3).
 *
 * `buildReportModel` takes PlatformFacts as untrusted data; this module is what makes them the platform's. A `ReportInputsPort`
 * answers, for one attempt's scope, only what the platform recorded: the manifest the validation receipt bound, the frozen quote,
 * the terms snapshot the issuer is read from, the platform's own populations and receipt counts, the branding version and the
 * finding and decision ids. Nothing is taken from a brand, a fixture of appearance or the package.
 *
 * - The issuer is read from the terms snapshot and from nowhere else: the snapshot is a canonical document whose SHA-256 IS
 *   `termsSha256`, so the issuer cannot differ from the terms the report names (closes R2-070's missing binding for this path).
 * - `countsBinding` is BOUND or the report is not produced: RowCounts come from `deliveryRowCountsOf` over the platform's
 *   populations and the bound receipt, the same rule the publication applies, so a package that the publication would refuse for its
 *   counts never gets a report that says UNBOUND.
 * - The report's identifiers are functions of the attempt's UUIDs, not free text: `rpt-<jobId>` and `pkg-<attemptId>` (the package
 *   version row is minted when the manifest is submitted, after the worker has run).
 */
import { canonicalBytes, isSha256Hex, parseCanonical, rawDigest } from "@kauro/contracts";
import { deliveryRowCountsOf, type DeliveryCountFacts } from "@kauro/domain";
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

export interface AuthorizedReportInputs {
  /** What produced these inputs. A simulator says SIMULATED; nothing here lets one be mistaken for the platform's records. */
  readonly evidenceClass: ReportInputsEvidenceClass;
  /** The scope the inputs were read for; they are refused for any other. */
  readonly scope: ReportScope;
  /** The manifest SHA-256 the platform's validation receipt bound (`artifactEvidenceHash`): the package this job must deliver. */
  readonly expectedManifestSha256: string;
  readonly quote: { readonly quoteId: string; readonly billableSourceUnits: number };
  readonly privacyClass: PrivacyClass;
  readonly branding: Branding;
  /** The stored logo's bytes when the branding names one. */
  readonly logo: Uint8Array | null;
  readonly terms: { readonly termsVersion: string; readonly snapshot: Uint8Array } | null;
  /** The sealed revision's populations and the bound receipt's counts, as the publication reads them. */
  readonly countFacts: DeliveryCountFacts | null;
  readonly findingIds: readonly string[];
  readonly materialDecisionIds: readonly string[];
}

export interface ReportInputsPort {
  /** The platform's recorded inputs for this attempt's report, or null when it has none. Throws only on an infrastructure failure. */
  read(scope: ReportScope): Promise<AuthorizedReportInputs | null>;
}

// --- the terms snapshot ---------------------------------------------------------------------------------------------------------

export const TERMS_SNAPSHOT_DOMAIN = "KAURO_REPORT_TERMS_SNAPSHOT_V1";

/** The canonical bytes of a terms snapshot: its SHA-256 is the `termsSha256` of every report that names this issuer. */
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

// --- assembly -------------------------------------------------------------------------------------------------------------------

const sameScope = (a: ReportScope, b: ReportScope): boolean => a.agencyId === b.agencyId && a.projectId === b.projectId && a.jobId === b.jobId && a.attemptId === b.attemptId;

/**
 * The PlatformFacts of the attempt's report, or a refusal naming why none can be made. Never returns facts with `declaredCounts`
 * null, an issuer the terms do not state, or inputs read for another scope.
 */
export function assembleReportFacts(scope: ReportScope, inputs: AuthorizedReportInputs | null, rendererVersion: string): PlatformFacts {
  if (inputs === null) throw new ReportStageError("FACTS_UNAVAILABLE", "the platform has no recorded inputs for this attempt's report");
  if (!sameScope(inputs.scope, scope)) throw new ReportStageError("FACTS_FOREIGN_SCOPE", "the inputs were read for another agency, project, job or attempt");
  if (!isSha256Hex(inputs.expectedManifestSha256)) throw new ReportStageError("FACTS_MALFORMED", "the receipt's manifest hash is not a SHA-256");
  if (inputs.terms === null) throw new ReportStageError("TERMS_UNAVAILABLE", "no terms snapshot names the issuer");
  const terms = readTermsSnapshot(inputs.terms.snapshot);
  if (!terms.ok) throw new ReportStageError("TERMS_UNVERIFIABLE", `the terms snapshot is not readable (${terms.problem})`);
  if (terms.termsVersion !== inputs.terms.termsVersion) throw new ReportStageError("TERMS_UNVERIFIABLE", "the snapshot is of another terms version than the one the platform names");
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
    billableSourceUnits: inputs.quote.billableSourceUnits,
    quoteId: inputs.quote.quoteId,
    branding: inputs.branding,
    termsVersion: terms.termsVersion,
    termsSha256: terms.sha256,
    issuer: terms.issuer,
    findingIds: [...inputs.findingIds],
    materialDecisionIds: [...inputs.materialDecisionIds],
    rendererVersion,
    declaredCounts: counted.counts,
  };
}

/**
 * CONTRACT SIMULATOR — SIMULATED: the platform's recorded inputs for a report (B13 x B08; docs/design/B13-report-delivery.md §3).
 *
 * The real source of these inputs is the platform's own records (@kauro/control PlatformReportInputs, order 6): the validation receipt
 * the job is bound to, the frozen quote and the issuer's legal identity document its terms name, the sealed revision's populations, the
 * agency's branding version, the subject's audit and the approval's disclosures. This simulator answers with invented, plainly
 * synthetic values in the simulator's own bindings and says `SIMULATED`; the stage refuses its inputs unless the test's composition
 * admits them (`admitSimulatedInputs`), and the assembler refuses its bindings from any input that does not say SIMULATED. It exists
 * so the contract of `ReportInputsPort` and the chain that consumes it can be exercised, and it must never be bound by a composition root.
 *
 * Importable only from a package's test/ directory (architecture rule testOnlySubpaths).
 */
import { rawDigest, type RowCounts } from "@kauro/contracts";
import type { Branding, PrivacyClass } from "@kauro/reports";
import { termsSnapshotBytesOf, type AuthorizedReportInputs, type ReportInputsPort, type ReportScope, type SnapshotTerms } from "../report/facts.js";

export const SIMULATED_REPORT_INPUTS_TOKEN = "simulated-report-inputs";
export const SIMULATED_ISSUER = Object.freeze({ legalName: "Simulated Issuer S.A.S.", jurisdiction: "Colombia", registrationId: "SIMULATED-0000" });
export const SIMULATED_TERMS_VERSION = "terms-simulated-1";

export interface SimulatedReportInputsSpec {
  /** The manifest SHA-256 of the package the job must deliver (what the validation receipt bound). */
  readonly expectedManifestSha256: string;
  /** The platform's counts for the package: they become both the sealed revision's populations and the receipt's counts. */
  readonly counts: RowCounts;
  readonly quoteId?: string;
  readonly privacyClass?: PrivacyClass;
  readonly branding?: Branding;
  readonly termsVersion?: string;
  readonly issuer?: { readonly legalName: string; readonly jurisdiction: string; readonly registrationId: string };
  readonly findingIds?: readonly string[];
  readonly materialDecisionIds?: readonly string[];
}

/** A terms snapshot of the issuer and the simulated record of it (version and hash), consistent with each other. */
export function simulatedTermsOf(termsVersion: string, issuer: { readonly legalName: string; readonly jurisdiction: string; readonly registrationId: string }): SnapshotTerms {
  const snapshot = termsSnapshotBytesOf(termsVersion, issuer);
  return { binding: "REPORT_TERMS_SNAPSHOT_V1", termsVersion, termsSha256: rawDigest(snapshot), snapshot };
}

/** Inputs for `scope`, internally consistent: the snapshot is the issuer's, the receipt counts are the populations plus the dispositions. */
export function simulatedReportInputsOf(scope: ReportScope, spec: SimulatedReportInputsSpec, overrides: Partial<AuthorizedReportInputs> = {}): AuthorizedReportInputs {
  const { physicalSourceRows, logicalSourceRecords, billableSourceUnits, associationEdges } = spec.counts;
  const termsVersion = spec.termsVersion ?? SIMULATED_TERMS_VERSION;
  return {
    evidenceClass: "SIMULATED",
    scope,
    subject: null,
    expectedManifestSha256: spec.expectedManifestSha256,
    quote: { quoteId: spec.quoteId ?? "q-simulated-1", billableSourceUnits },
    privacyClass: spec.privacyClass ?? "SECURE_DETAIL",
    branding: { binding: "SIMULATED", branding: spec.branding ?? { version: "brand-simulated-1", displayName: "Northwind Data Partners", logo: null } },
    logo: null,
    terms: simulatedTermsOf(termsVersion, spec.issuer ?? SIMULATED_ISSUER),
    countFacts: { populations: { physicalSourceRows, logicalSourceRecords, billableSourceUnits, associationEdges }, receiptCounts: { ...spec.counts } },
    findings: { binding: "SIMULATED", ids: spec.findingIds ?? ["F-1", "F-2"] },
    materialDecisions: { binding: "SIMULATED", ids: spec.materialDecisionIds ?? ["D-1"] },
    ...overrides,
  };
}

/** A `ReportInputsPort` answering from a function, with the scopes it was asked for. */
export class SimulatedReportInputs implements ReportInputsPort {
  readonly evidenceClass = "SIMULATED";
  readonly token = SIMULATED_REPORT_INPUTS_TOKEN;
  readonly asked: ReportScope[] = [];
  readonly #answer: (scope: ReportScope) => AuthorizedReportInputs | null | Promise<AuthorizedReportInputs | null>;

  constructor(answer: (scope: ReportScope) => AuthorizedReportInputs | null | Promise<AuthorizedReportInputs | null>) {
    this.#answer = answer;
  }

  async read(scope: ReportScope): Promise<AuthorizedReportInputs | null> {
    this.asked.push(scope);
    return this.#answer(scope);
  }
}

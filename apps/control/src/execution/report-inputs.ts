/**
 * The platform's `ReportInputsPort` (order 6; docs/design/B13-report-inputs.md): the inputs of one attempt's report, read from the
 * platform's records by the control plane.
 *
 * One SYSTEM unit of work of JOB_EXECUTION bound to the job's agency (kauro_control under forced row security, D-CTRL-1) reads, through
 * @kauro/persistence reportSourcesOf, the attempt of the scope's job, the job's subject, its VALID receipt, the quote its commercial
 * authorization names with every member of the quote's terms preimage, the agency's acceptance of that terms version, the fiscal issuer
 * the preimage names and its legal identity document, the agency's branding version in force when the job was queued, the subject's
 * audit and the job's approval and plan; and, through the execution store, the counts the publication itself reads (`deliveryCountFacts`).
 * The disclosure set is composed again from the plan and the receipt by the edition's own composer (@kauro/application
 * disclosureItemsOf). Nothing is verified or defaulted here: every record is passed in its binding, a missing one as null, and
 * @kauro/data-plane assembleReportFacts verifies each against the hash another record holds and refuses what it cannot verify.
 *
 * Where it runs: the worker that renders the report (B14's host, not built) receives these inputs through its composition and never a
 * database connection; this module is the control plane's side of that boundary. No composition root binds it yet.
 */
import { disclosureItemsOf } from "@kauro/application";
import { B08_PACKAGE_REPORT_PRIVACY_CLASS, type AuthorizedReportInputs, type ReportDecisionsInputs, type ReportInputsPort, type ReportScope } from "@kauro/data-plane";
import type { AgencyId, CorrelationId, ExecutionUnitOfWorkFactory, IdGenerator, ProcessingJobId, RecordedReportFacts } from "@kauro/domain";
import { reportSourcesOf } from "@kauro/persistence";
import { EXECUTION_SERVICES, boundSystem } from "./work.js";

export interface PlatformReportInputsDependencies {
  readonly units: ExecutionUnitOfWorkFactory;
  readonly ids: IdGenerator;
}

/** The disclosure set of the job's approval, composed from its plan and receipt; null when any of the three is not recorded. */
function decisionsOf(recorded: RecordedReportFacts): ReportDecisionsInputs | null {
  const { approval, plan, receipt } = recorded;
  if (approval === null || plan === null || receipt === null || receipt.physicalSourceRows === null) return null;
  const mappings = (plan.body as { readonly mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) return null;
  let items: readonly string[];
  try {
    items = disclosureItemsOf(plan.body, receipt.physicalSourceRows);
  } catch {
    return null;
  }
  return { binding: "APPROVAL_DISCLOSURES_V1", approvalId: approval.approvalId, planHash: approval.planHash, receiptHash: approval.receiptHash, disclosuresHash: approval.disclosuresHash, items };
}

/** The recorded facts in the bindings the assembler verifies (see the header). */
export function reportInputsOf(recorded: RecordedReportFacts, countFacts: AuthorizedReportInputs["countFacts"]): AuthorizedReportInputs | null {
  const { job, receipt, quote, issuer, branding, audit } = recorded;
  if (receipt === null) return null;
  return {
    evidenceClass: "EXECUTED_LOCAL",
    scope: recorded.scope,
    subject: {
      planId: job.planId,
      planHash: job.planHash,
      approvalId: job.approvalId,
      revisionHash: job.revisionHash,
      targetContractHash: job.targetContractHash,
      validationReceiptHash: job.validationReceiptHash,
    },
    expectedManifestSha256: receipt.artifactEvidenceHash,
    quote: quote === null ? null : { quoteId: quote.preimage.quoteId, billableSourceUnits: quote.preimage.billableUnits },
    privacyClass: B08_PACKAGE_REPORT_PRIVACY_CLASS,
    branding: branding === null ? null : { binding: "AGENCY_BRANDING_V1", agencyId: branding.agencyId, version: branding.version, displayName: branding.displayName, recordedAt: branding.recordedAt },
    logo: null,
    terms:
      quote === null
        ? null
        : {
            binding: "QUOTE_TERMS_V1",
            termsVersion: quote.preimage.termsVersion,
            termsSha256: quote.termsHash,
            quoteState: quote.state,
            preimage: quote.preimage,
            acceptance: recorded.termsAcceptance,
            issuer: issuer === null ? null : { ...issuer, identity: recorded.legalIdentity },
          },
    countFacts,
    findings: audit === null ? null : { binding: "AUDIT_FINDINGS_V1", auditId: audit.auditId, auditState: audit.state, codes: audit.findingCodes },
    materialDecisions: decisionsOf(recorded),
  };
}

export class PlatformReportInputs implements ReportInputsPort {
  readonly #d: PlatformReportInputsDependencies;

  constructor(dependencies: PlatformReportInputsDependencies) {
    this.#d = dependencies;
  }

  /** The attempt's inputs, or null when the attempt is not one of the scope's job, project and agency, or its receipt is not visible. */
  async read(scope: ReportScope): Promise<AuthorizedReportInputs | null> {
    return this.#d.units.run(boundSystem(EXECUTION_SERVICES.JOB_EXECUTION, scope.agencyId as AgencyId, this.#d.ids.next() as CorrelationId), async (uow) => {
      const recorded = await reportSourcesOf(uow).read(scope);
      if (recorded === null) return null;
      const job = await uow.execution.getJob(scope.jobId as ProcessingJobId);
      if (job === null) return null;
      return reportInputsOf(recorded, await uow.execution.deliveryCountFacts(job));
    });
  }
}

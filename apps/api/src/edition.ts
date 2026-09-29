/**
 * Collaborators of the B06 edition (design §2: the plan-side ports — ArtifactResolver, PlanPatchCompiler,
 * DisclosureComposer — are "collaborators the B06 commands need but do not own"; their adapters arrive with the data-plane,
 * migration-core and reporting packages). The api binds here exactly what this edition owns and names what it does not:
 *
 * - `activeWorkInspector`: the retained active work of a client is its open projects (D-CMD-3) and — since package B09 — the
 *   live commercial authorizations of its projects (`commercialInspectionsOf(uow).liveAuthorizationsOfClient`, B09 D-INSP-B1),
 *   read in the command's own unit of work under its tenant policies; jobs extend the summary with package B08, so their count is
 *   the zero of an edition in which the ProcessingJob aggregate does not exist (07 "Aggregate ownership").
 * - `noExternalActionsInThisEdition`: CMD026 identifies completed external actions separately (import stages, delivered
 *   packages). No ImportStage or PackageVersion aggregate exists in the B06 schema, so the set is empty by construction.
 * - `commercialConsequencesInspector`: CMD023 revising an APPROVED plan checks the edge guard "Commercial/execution
 *   consequences are reconciled" (registry Plan machine). The facts that could be unreconciled are a Quote, a PaymentOrder, a
 *   CommercialAuthorization or a ProcessingJob resting on the approval (07 "Aggregate ownership"). Package B09 binds its own:
 *   the plan's live quotes, the open payment orders of those quotes and its non-revoked commercial authorizations
 *   (`commercialInspectionsOf(uow).unreconciledForPlan`, B09 D-INSP-B1; the re-check's residual FINAL-N3); B08 adds its jobs
 *   through the same port.
 * - `unavailablePlanServices`: CMD023 and CMD025 need the typed patch compiler and the disclosure composer. Until their
 *   packages bind real adapters the routes answer INTEGRITY_FAILURE / PLAN_SERVICES_UNAVAILABLE inside the unit of work
 *   (rolled back, no journal row, no effect): 07 "Command outcomes and error taxonomy" — integrity failure is a distinct,
 *   nonretryable outcome "until the subject or implementation changes"; 07 "Acceptance obligations" — "a downstream team must
 *   not fill a missing domain rule with a local guess"; 21 "Gate aliases and scoped closures" — a local result is never
 *   presented as live readiness. Decision I-INT-2 in docs/design/B06-domain-db-authz.md.
 * - `commercialScopeInspector` (B07 port, bound by the B07 + B09 merge): CMD012's impact map names the live commercial
 *   authorizations bound to the revision it replaces (docs/design/B07-upload-source-lifecycle.md §17 item 7; B09 design §15 item 6):
 *   the replaced revision's manifest hash read in CMD012's own source unit of work (B07's source store), then package B09's
 *   CommercialAuthorizationRepository.findLiveByRevisionHash under the same tenant context, mapped to the authorization ids.
 * - `sourceAvailabilityReader` and `sourceLineageReader` (B09 ports, bound by the B07 + B09 merge): the availability of a
 *   quoted source (checkout and capture re-check SOURCE_EXPIRED, D-QUOTE-B7) and the lineage of a replacement (the re-binding,
 *   D-QUOTE-B6) are the source lifecycle's own answers over its tables (@kauro/persistence commercialSourceReadsOf: B07's
 *   SourceAvailabilityReader, retention records and RevisionLineageReader), never a contract fake (D-FAKE-B1).
 * - The source-lifecycle provider adapters (object storage, session vault) and the preview reader are not bound by this edition
 *   (B07 D-SAPI-6): the composition root leaves them null, so every source command and read that needs one answers
 *   INTEGRITY_FAILURE / SOURCE_SERVICES_UNAVAILABLE and reserves nothing; B15 binds the real adapters.
 */
import type {
  ActiveWorkInspector,
  ArtifactResolver,
  CommerceRequestCollaborators,
  CommerceRequestQueries,
  CommercialConsequenceInspector,
  CommercialScopeInspector,
  DisclosureComposer,
  ExternalActionInspector,
  PlanPatchCompiler,
  PurchasedSubjectReader,
  SourceAvailabilityReader,
  SourceLineageReader,
} from "@kauro/application";
import { DomainFailure } from "@kauro/domain";
import { commerceRequestReadsOf, commercialAuthorizationsOf, commercialInspectionsOf, commercialSourceReadsOf, purchasedSubjectsOf, sourceStoreOf } from "@kauro/persistence";

export const activeWorkInspector: ActiveWorkInspector = {
  async inspectClient(uow, clientId) {
    return {
      openProjects: await uow.endClients.countOpenProjects(clientId),
      activeJobs: 0,
      liveCommercialAuthorizations: await commercialInspectionsOf(uow).liveAuthorizationsOfClient(clientId),
    };
  },
};

export const noExternalActionsInThisEdition: ExternalActionInspector = {
  async completedForPlan() {
    return [];
  },
};

export const commercialConsequencesInspector: CommercialConsequenceInspector = {
  async unreconciledForPlan(uow, planId) {
    return commercialInspectionsOf(uow).unreconciledForPlan(planId);
  },
};

export const commercialScopeInspector: CommercialScopeInspector = {
  async authorizationsBoundTo(uow, agencyId, revisionId) {
    const revision = await sourceStoreOf(uow).revisions.get(revisionId);
    if (revision === null || revision.manifestHash === undefined) return [];
    const live = await commercialAuthorizationsOf(uow).findLiveByRevisionHash(agencyId, revision.manifestHash);
    return live.map((a) => a.authorizationId);
  },
};

/** The source lifecycle's availability of a quoted source (B07), as the payments workflow asks for it (B09 D-QUOTE-B7). */
export const sourceAvailabilityReader: SourceAvailabilityReader = {
  binding: "PLATFORM",
  availabilityOf: (uow, request) => commercialSourceReadsOf(uow).availabilityOf(request),
};

/** The source lifecycle's lineage of a replacement revision (B07 CMD012), as the re-binding asks for it (B09 D-QUOTE-B6). */
export const sourceLineageReader: SourceLineageReader = {
  binding: "PLATFORM",
  replacementOf: (uow, request) => commercialSourceReadsOf(uow).replacementOf(request),
};

function unavailable(service: string): DomainFailure {
  return new DomainFailure("INTEGRITY_FAILURE", `${service} is not bound in this edition of the api`, { reason: "PLAN_SERVICES_UNAVAILABLE" });
}

export interface PlanServices {
  readonly artifacts: ArtifactResolver;
  readonly patchCompiler: PlanPatchCompiler;
  readonly disclosures: DisclosureComposer;
}

export function unavailablePlanServices(): PlanServices {
  return {
    artifacts: {
      async resolveDecisionPatch() {
        throw unavailable("ArtifactResolver");
      },
    },
    patchCompiler: {
      async apply() {
        throw unavailable("PlanPatchCompiler");
      },
    },
    disclosures: {
      async compose() {
        throw unavailable("DisclosureComposer");
      },
    },
  };
}

// --- package B09: the request side of the payments workflow (implementation mandate M4; D-REQ-B1, D-REQ-B2, D-CORE-B2) ------------

/**
 * The purchased subject of a quote as the caller's commerce unit of work reads it (PurchasedSubjectReader, D-CORE-B2): the persistence
 * adapter's column-scoped read (@kauro/persistence PgPurchasedSubjects, D-M3-B3) after the shared halves of the transition locks, under
 * the caller's policies — a TENANT context of the request handlers, or a SERVICE context of the payment service after it adopted the
 * stored operation's agency. The one adapter of the port (D-REQ-B2, D-INT2-B2): the request side's handlers, the payment service's
 * reconciler and its re-binder all read the subject through it.
 */
export const purchasedSubjectReader: PurchasedSubjectReader = {
  subjectOf: (uow, quote) => purchasedSubjectsOf(uow).subjectOf(quote),
};

/** The request side's queries (D-REQ-B2), bound to the persistence adapter's reads of the caller's unit of work. */
export const commerceRequestQueries: CommerceRequestQueries = {
  awaitTransition: (uow, kind, subject) => commerceRequestReadsOf(uow).awaitTransition(kind, subject),
  ordersOfQuote: (uow, quoteId) => commerceRequestReadsOf(uow).ordersOfQuote(quoteId),
  completedCaptureOfQuote: (uow, quoteId) => commerceRequestReadsOf(uow).completedCaptureOfQuote(quoteId),
  latestCompletedCaptureOfProject: (uow, projectId) => commerceRequestReadsOf(uow).latestCompletedCaptureOfProject(projectId),
  activeRefundPolicies: (uow, limit) => commerceRequestReadsOf(uow).activeRefundPolicies(limit),
};

/**
 * The payment collaborators of this edition (D-REQ-B1). It binds what it owns — the reads of its own database — and names what it
 * does not: the payment provider adapter and the payment service's pool arrive with the integration package (B15) and the payment
 * service's composition (ApiAssembly.payments: the composition root then takes both from the bound payment service, D-INT2-B3);
 * without them CreatePaymentOrder and CapturePayment answer INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE inside the unit of work
 * with nothing written; B08's admission is not bound, so deliverable capacity is "unanswered" and checkout answers
 * CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE (D-CAP-B1); B07's source availability is the platform's own
 * (sourceAvailabilityReader, bound since the B07 + B09 merge). A deployment, and the tests, bind the rest through ApiAssembly.commerce;
 * nothing here is a fake (D-FAKE-B1: no production wiring binds one).
 */
export function commerceEdition(): CommerceRequestCollaborators {
  return {
    payment: null,
    paymentServiceId: "payment-service",
    provider: null,
    subjects: purchasedSubjectReader,
    queries: commerceRequestQueries,
    capacity: null,
    sources: sourceAvailabilityReader,
  };
}

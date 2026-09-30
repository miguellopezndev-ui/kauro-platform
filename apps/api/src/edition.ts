/**
 * Collaborators of the B06 edition (design §2: the plan-side ports — ArtifactResolver, PlanPatchCompiler,
 * DisclosureComposer — are "collaborators the B06 commands need but do not own"; their adapters arrive with the data-plane,
 * migration-core and reporting packages). The api binds here exactly what this edition owns and names what it does not:
 *
 * - `activeWorkInspector`: the retained active work of a client is its open projects (D-CMD-3) and — since package B09 — the
 *   live commercial authorizations of its projects (`commercialInspectionsOf(uow).liveAuthorizationsOfClient`, B09 D-INSP-B1),
 *   read in the command's own unit of work under its tenant policies; since package B08 the summary's `activeJobs` is the count of
 *   the live processing jobs of the client's projects (`executionReadsOf(uow).activeJobsOfClient`, B08 D8-XPKG-3: reported, never a
 *   decision, CMD010 retains the work).
 * - `externalActionInspector`: CMD026 identifies completed external actions separately (import stages, delivered packages). Since
 *   package B08 the delivered packages of the plan are read from its own tables (`executionReadsOf(uow).deliveredPackagesForPlan`,
 *   PACKAGE_DELIVERED, never promised reversible); no import stage exists in this edition, so IMPORT_STAGE_* facts are never named.
 * - `commercialConsequencesInspector`: CMD023 revising an APPROVED plan checks the edge guard "Commercial/execution
 *   consequences are reconciled" (registry Plan machine). The facts that could be unreconciled are a Quote, a PaymentOrder, a
 *   CommercialAuthorization or a ProcessingJob resting on the approval (07 "Aggregate ownership"). Package B09 binds its own:
 *   the plan's live quotes, the open payment orders of those quotes and its non-revoked commercial authorizations
 *   (`commercialInspectionsOf(uow).unreconciledForPlan`, B09 D-INSP-B1; the re-check's residual FINAL-N3); since package B08 the
 *   plan's live jobs are named through the same port, after B09's facts (`executionReadsOf(uow).unreconciledJobsForPlan`, D8-XPKG-3).
 * - `planServices`: CMD023 and CMD025 need the typed patch compiler and the disclosure composer, and CMD023 the artifact resolver. Since
 *   package B08 the edition binds all three: the decision artifacts of migration 0021 (@kauro/persistence decisionArtifactResolver), the
 *   patch compiler over the Intelligence core's plan compiler (`patchCompilerOver`) and the real disclosure composer (D8-CMA-6). A
 *   deployment that binds no adapter of the core (ApiAssembly.cores absent) answers INTEGRITY_FAILURE / CORE_SERVICES_UNAVAILABLE for
 *   CMD022 and CMD023 inside the unit of work (rolled back, no journal row, no effect): 07 "Command outcomes and error taxonomy" -
 *   integrity failure is a distinct, nonretryable outcome "until the subject or implementation changes"; 07 "Acceptance obligations" -
 *   "a downstream team must not fill a missing domain rule with a local guess"; 21 "Gate aliases and scoped closures" - a local
 *   result is never presented as live readiness. Decision I-INT-2 in docs/design/B06-domain-db-authz.md, refined by D8-CMA-5.
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
  CoreServices,
  DeliveryCapacityPort,
  DisclosureComposer,
  ExternalActionInspector,
  PlanPatchCompiler,
  PurchasedSubjectReader,
  SourceAvailabilityReader,
  SourceLineageReader,
} from "@kauro/application";
import { disclosureComposer, patchCompilerOver } from "@kauro/application";
import { commerceRequestReadsOf, commercialAuthorizationsOf, commercialInspectionsOf, commercialSourceReadsOf, decisionArtifactResolver, executionReadsOf, purchasedSubjectsOf, sourceStoreOf } from "@kauro/persistence";

export const activeWorkInspector: ActiveWorkInspector = {
  async inspectClient(uow, clientId) {
    return {
      openProjects: await uow.endClients.countOpenProjects(clientId),
      activeJobs: await executionReadsOf(uow).activeJobsOfClient(clientId),
      liveCommercialAuthorizations: await commercialInspectionsOf(uow).liveAuthorizationsOfClient(clientId),
    };
  },
};

export const externalActionInspector: ExternalActionInspector = {
  async completedForPlan(uow, planId) {
    return executionReadsOf(uow).deliveredPackagesForPlan(planId);
  },
};

export const commercialConsequencesInspector: CommercialConsequenceInspector = {
  async unreconciledForPlan(uow, planId) {
    return [...(await commercialInspectionsOf(uow).unreconciledForPlan(planId)), ...(await executionReadsOf(uow).unreconciledJobsForPlan(planId))];
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

export interface PlanServices {
  readonly artifacts: ArtifactResolver;
  readonly patchCompiler: PlanPatchCompiler;
  readonly disclosures: DisclosureComposer;
}

/**
 * The plan services of this edition over the cores it is composed with (D8-CMA-5, D8-CMA-6): the artifacts are the platform's own decision
 * artifacts, the patch compiler is the core's plan compiler (an unbound core refuses inside the unit of work, D8-PORT-1) and the
 * disclosure composer is computed from records alone.
 */
export function planServices(cores: CoreServices): PlanServices {
  return {
    artifacts: decisionArtifactResolver,
    patchCompiler: patchCompilerOver(cores),
    disclosures: disclosureComposer,
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
 * B08's deliverable capacity (D8-XPKG-4, D8-CAP-2): checkout never sells into a hidden queue, so B09's DeliveryCapacityPort answers from the
 * agency's live-job ledger, the same three-live-jobs bound ExecuteProject enforces (@kauro/persistence executionReadsOf). It binds PLATFORM: the
 * reading is the platform's own database, never a contract fake.
 */
export const deliveryCapacity: DeliveryCapacityPort = {
  binding: "PLATFORM",
  checkoutCapacity: (uow, request) => executionReadsOf(uow).checkoutCapacity({ agencyId: request.agencyId }),
};

/**
 * The payment collaborators of this edition (D-REQ-B1). It binds what it owns — the reads of its own database — and names what it
 * does not: the payment provider adapter and the payment service's pool arrive with the integration package (B15) and the payment
 * service's composition (ApiAssembly.payments: the composition root then takes both from the bound payment service, D-INT2-B3);
 * without them CreatePaymentOrder and CapturePayment answer INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE inside the unit of work
 * with nothing written; deliverable capacity is B08's own since its commands are served (deliveryCapacity, D8-XPKG-4: the agency's
 * live-job ledger), and a deployment that leaves the binding out still answers CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE
 * (D-CAP-B1); B07's source availability is the platform's own
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
    capacity: deliveryCapacity,
    sources: sourceAvailabilityReader,
  };
}

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
 * - `noCommercialAuthorizationsBeforePayments` (B07): CMD012's impact map names the live commercial authorizations bound to the
 *   revision it replaces (docs/design/B07-upload-source-lifecycle.md §17 item 7). CommercialAuthorization is the payments
 *   package's aggregate (B09; 07 "Aggregate ownership"): no table of it exists before B09, so no authorization can be bound and the
 *   set is empty by construction — the edition's production answer, not a stand-in. B09 binds its reader through the same port.
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
} from "@kauro/application";
import { DomainFailure } from "@kauro/domain";
import { commerceRequestReadsOf, commercialInspectionsOf, purchasedSubjectsOf } from "@kauro/persistence";

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

export const noCommercialAuthorizationsBeforePayments: CommercialScopeInspector = {
  async authorizationsBoundTo() {
    return [];
  },
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
 * CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE (D-CAP-B1); B07's source availability is not bound, so a quote's own promise
 * (Quote.sourceAvailableUntil, D-QUOTE-B7) and its revision's SEALED state decide. A deployment, and the tests, bind the rest through
 * ApiAssembly.commerce; nothing here is a fake (D-FAKE-B1: no production wiring binds one).
 */
export function commerceEdition(): CommerceRequestCollaborators {
  return {
    payment: null,
    paymentServiceId: "payment-service",
    provider: null,
    subjects: purchasedSubjectReader,
    queries: commerceRequestQueries,
    capacity: null,
    sources: null,
  };
}

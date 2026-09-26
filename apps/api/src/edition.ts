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
 */
import type { ActiveWorkInspector, ArtifactResolver, CommercialConsequenceInspector, DisclosureComposer, ExternalActionInspector, PlanPatchCompiler } from "@kauro/application";
import { DomainFailure } from "@kauro/domain";
import { commercialInspectionsOf } from "@kauro/persistence";

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

/**
 * The core services an api process is composed with (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §10,
 * D8-PORT-1): the ports of the cores the request side reaches. A deployment that binds no adapter has none, and every route that
 * needs one answers INTEGRITY_FAILURE / CORE_SERVICES_UNAVAILABLE inside its unit of work — never a stub standing in for a core.
 *
 * Only CMD022 and CMD023 reach a core from the request side: the Intelligence core's plan compiler compiles the audit's candidate
 * decisions into a plan body (CreatePlan) and a decision patch onto an existing plan (RevisePlan, bound through `patchCompilerOver`).
 * The rest of the cores' ports (profile, interpret, validate, execute, verify) belong to the control plane's composition.
 */
import { DomainFailure } from "@kauro/domain";
import type { PlanCompilerPort } from "../ports/core-ports.js";
import type { PlanPatchCompiler } from "../ports/plan-services.js";

export interface CoreServices {
  readonly planCompiler: PlanCompilerPort;
}

/**
 * The cores of a deployment that binds no adapter (D8-PORT-1): the plan compiler refuses inside the caller's unit of work, which rolls
 * back — no plan, no journal row, no effect. INTEGRITY_FAILURE is a distinct, nonretryable outcome "until the subject or implementation
 * changes" (07 "Command outcomes and error taxonomy"): a missing core is never filled with a local guess.
 */
export function unavailableCoreServices(): CoreServices {
  return {
    planCompiler: {
      async compile() {
        throw new DomainFailure("INTEGRITY_FAILURE", "the Intelligence core is not bound in this edition of the api", { reason: "CORE_SERVICES_UNAVAILABLE" });
      },
    },
  };
}

/**
 * B06's PlanPatchCompiler over the Intelligence core's plan compiler: a decision patch applied to a plan's current body is the
 * patch's document compiled against that body (D8-PLAN-1), so CMD023 RevisePlan and CMD022 CreatePlan reach one compiler and one
 * rejection vocabulary.
 */
export function patchCompilerOver(cores: CoreServices): PlanPatchCompiler {
  return {
    apply: (current, patch) => cores.planCompiler.compile(patch.document, current),
  };
}

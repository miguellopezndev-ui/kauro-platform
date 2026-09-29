/**
 * The core services an api process is composed with (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §10,
 * D8-PORT-1): the ports of the cores the request side reaches. A deployment that binds no adapter has none, and every route that
 * needs one answers INTEGRITY_FAILURE / CORE_SERVICES_UNAVAILABLE inside its unit of work — never a stub standing in for a core.
 *
 * Only CMD022 and CMD023 reach a core from the request side: the Intelligence core's plan compiler compiles the audit's candidate
 * decisions into a plan body (CreatePlan) and a decision patch onto an existing plan (RevisePlan, bound through `patchCompilerOver`).
 * The rest of the cores' ports (profile, interpret, validate, execute, verify) belong to the control plane's composition.
 */
import type { PlanCompilerPort } from "../ports/core-ports.js";

export interface CoreServices {
  readonly planCompiler: PlanCompilerPort;
}

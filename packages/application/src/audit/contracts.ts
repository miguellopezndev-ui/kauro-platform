/**
 * The four B08 audit request commands (CMD020 StartAudit, CMD021 CancelAudit, CMD022 CreatePlan, CMD024 ValidatePlan), the GetAudit
 * read and the decision-artifact intake: input body (exactly the registry fields), result view and the spec the transport and the
 * authorizer consume. Behaviour — locks in the order of D8-LOCK-1, preconditions in order, writes, events, OK/DENY/RACE — is
 * specified in docs/design/B08-audit-approval-jobs.md §3, §12 (D8-API-1) and §13 (D8-CMA-n); the handlers are audit/handlers.
 *
 * The commands are served through B06's pipeline in an audit unit of work (`runCommandIn`/`runReadIn`, B07 D-CMD-10): the same
 * access decision, journal reservation, assurance and denial facts as every other command.
 */
import type { AuditState } from "@kauro/domain";
import type { CommandResult } from "../api/envelope.js";
import type { CommandHandler, CommandSpec } from "../ports/command-handler.js";
import type { PlanView } from "../api/views.js";
import type { AuditView } from "./views.js";

function spec<Body>(s: CommandSpec<Body>): CommandSpec<Body> {
  return Object.freeze(s);
}

/** How long a caller waits before polling the status path of an accepted audit command (design §12: pollAfterSeconds 10). */
export const AUDIT_POLL_AFTER_SECONDS = 10;

// --- CMD020 StartAudit ----------------------------------------------------------------------------------------------------------

export interface StartAuditBody {
  /** The confirmed, current target contract the audit interprets the revision against. */
  readonly targetContractId: string;
  /** The audit policy version the caller was shown; kept on the audit row. */
  readonly auditPolicyVersion: string;
}
/**
 * StartAudit answers 202 with B06's ACCEPTED envelope: the operation is the audit — operationId = the audit id, state = QUEUED,
 * statusPath = /api/v1/audits/{auditId}, pollAfterSeconds = AUDIT_POLL_AFTER_SECONDS. The journal stores exactly this answer with status
 * 202 and a replay answers it again; progress is read at the status path (AuditView). No view rides on the 202: the envelope is closed.
 */
export type StartAuditAccepted = Omit<Extract<CommandResult<never>, { readonly kind: "ACCEPTED" }>, "kind" | "status"> & { readonly state: AuditState };
export const START_AUDIT: CommandSpec<StartAuditBody> = spec<StartAuditBody>({
  id: "CMD020",
  name: "StartAudit",
  method: "POST",
  path: "/api/v1/revisions/{revisionId}/audits",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "revisionId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["targetContractId", "auditPolicyVersion"],
});
/** A handler whose only success is the ACCEPTED answer (its CommandResult never carries a COMPLETED view). */
export type StartAuditHandler = CommandHandler<StartAuditBody, never>;

// --- CMD021 CancelAudit ---------------------------------------------------------------------------------------------------------

export interface CancelAuditBody {
  /** The audit's version (Audit.version: the fence between a cancellation and the orchestration's edges). */
  readonly expectedVersion: number;
}
export const CANCEL_AUDIT: CommandSpec<CancelAuditBody> = spec<CancelAuditBody>({
  id: "CMD021",
  name: "CancelAudit",
  method: "POST",
  path: "/api/v1/audits/{auditId}/cancel",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "auditId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion"],
});
export type CancelAuditHandler = CommandHandler<CancelAuditBody, AuditView>;

// --- CMD022 CreatePlan ----------------------------------------------------------------------------------------------------------

export interface CreatePlanBody {
  /** The agency's CANDIDATE_DECISIONS artifact of this audit (the decision-artifact intake). */
  readonly candidateDecisionArtifactRef: string;
}
export const CREATE_PLAN: CommandSpec<CreatePlanBody> = spec<CreatePlanBody>({
  id: "CMD022",
  name: "CreatePlan",
  method: "POST",
  path: "/api/v1/audits/{auditId}/plans",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "auditId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["candidateDecisionArtifactRef"],
});
export type CreatePlanHandler = CommandHandler<CreatePlanBody, PlanView>;

// --- CMD024 ValidatePlan --------------------------------------------------------------------------------------------------------

export interface ValidatePlanBody {
  /** The plan's version (Plan.version: the fence between a validation request and a concurrent edit). */
  readonly expectedVersion: number;
  /** The plan body hash the caller reviewed: a body that changed meanwhile is a stale request, never a validation of unseen content. */
  readonly planHash: string;
}
/**
 * ValidatePlan answers 202 with B06's ACCEPTED envelope: the operation is the plan's validation — operationId = the plan id, state =
 * VALIDATING, statusPath = /api/v1/plans/{planId}, pollAfterSeconds = AUDIT_POLL_AFTER_SECONDS (D8-CMA-4).
 */
export type ValidatePlanAccepted = Omit<Extract<CommandResult<never>, { readonly kind: "ACCEPTED" }>, "kind" | "status"> & { readonly state: "VALIDATING" };
export const VALIDATE_PLAN: CommandSpec<ValidatePlanBody> = spec<ValidatePlanBody>({
  id: "CMD024",
  name: "ValidatePlan",
  method: "POST",
  path: "/api/v1/plans/{planId}/validate",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "planId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "planHash"],
});
export type ValidatePlanHandler = CommandHandler<ValidatePlanBody, never>;

export const AUDIT_COMMANDS = Object.freeze({
  CMD020: START_AUDIT,
  CMD021: CANCEL_AUDIT,
  CMD022: CREATE_PLAN,
  CMD024: VALIDATE_PLAN,
} as const);
export type AuditCommandId = keyof typeof AUDIT_COMMANDS;

export interface AuditHandlers {
  readonly CMD020: StartAuditHandler;
  readonly CMD021: CancelAuditHandler;
  readonly CMD022: CreatePlanHandler;
  readonly CMD024: ValidatePlanHandler;
}

// --- the read and the intake ---------------------------------------------------------------------------------------------------

/** The routes of the audit package beside its commands: the audit read (not a catalogue command; no journal entry). */
export type AuditRouteId = "GetAudit";

export interface AuditRouteSpec {
  readonly method: "GET";
  readonly path: string;
  /** Registry role vocabulary (B06 D-AUTHZ-1): AGENCY_READER is any live ACTIVE membership. */
  readonly role: "AGENCY_READER";
  readonly status: 200;
  readonly view: string;
  readonly authority: string;
}

/**
 * The audit read as a served manual-10 read: a GET without a body or an idempotency key, scope AGENCY_HEADER, the action token its
 * security facts carry (read-specs). Every live ACTIVE member reads an audit's safe progress, whatever the role (design §12).
 */
export const AUDIT_ROUTES: Readonly<Record<AuditRouteId, AuditRouteSpec>> = Object.freeze({
  GetAudit: {
    method: "GET",
    path: "/api/v1/audits/{auditId}",
    role: "AGENCY_READER",
    status: 200,
    view: "AuditView",
    authority: "B08 design §12 (D8-API-1): the status path of StartAudit's ACCEPTED answer; 10 \"Long work returns 202 with operationId, current state, status URL and allowed polling guidance\"; 10 \"Responses and safe errors\"",
  },
});

/** The decision-artifact intake of an audit (D8-PLAN-1): one route, one operation id, beside the source lifecycle's intakes. */
export type AuditIntakeId = "SubmitDecisionArtifact";

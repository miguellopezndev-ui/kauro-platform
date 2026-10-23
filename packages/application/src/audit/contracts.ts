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
import type { AuditView, ImportStageView, TargetContractView } from "./views.js";

function spec<Body>(s: CommandSpec<Body>): CommandSpec<Body> {
  return Object.freeze(s);
}

/** How long a caller waits before polling the status path of an accepted audit command (design §12: pollAfterSeconds 10). */
export const AUDIT_POLL_AFTER_SECONDS = 10;

// --- CMD020 StartAudit ----------------------------------------------------------------------------------------------------------

export interface StartAuditBody {
  /**
   * The confirmed, current target contract the audit interprets the revision against. Required by the in-force schema; under the candidate
   * activation (CP-02.01, Order 20) absent for a CLEAN project, which binds CLEAN_ONLY_TARGET_HASH instead.
   */
  readonly targetContractId?: string;
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

// --- CMD018 CreateTargetContract ------------------------------------------------------------------------------------------------

export interface CreateTargetContractBody {
  /** The admitted structured metadata artifact of the project's target instance: data, never executable schema. */
  readonly metadataArtifactRef: string;
  /** The importer profile the contract is qualified against. */
  readonly importerProfileId: string;
}
export const CREATE_TARGET_CONTRACT: CommandSpec<CreateTargetContractBody> = spec<CreateTargetContractBody>({
  id: "CMD018",
  name: "CreateTargetContract",
  method: "POST",
  path: "/api/v1/projects/{projectId}/target-contracts",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["metadataArtifactRef", "importerProfileId"],
});
export type CreateTargetContractHandler = CommandHandler<CreateTargetContractBody, TargetContractView>;

// --- CMD019 ConfirmTargetContract -----------------------------------------------------------------------------------------------

export interface ConfirmTargetContractBody {
  /** The contract's version (TargetContract.version: the fence between a confirmation and a concurrent one). */
  readonly expectedVersion: number;
  /** The body digest the confirming actor was shown: a digest that is not the stored body's is a stale request, never a confirmation of unseen content. */
  readonly bodyHash: string;
  /** The evidence of what was disclosed to the confirming actor (the complete body and the destination scope). */
  readonly confirmationEvidenceRef: string;
}
export const CONFIRM_TARGET_CONTRACT: CommandSpec<ConfirmTargetContractBody> = spec<ConfirmTargetContractBody>({
  id: "CMD019",
  name: "ConfirmTargetContract",
  method: "POST",
  path: "/api/v1/target-contracts/{contractId}/confirm",
  role: "AGENCY_APPROVER",
  scope: "AGENCY_HEADER",
  aggregateParam: "contractId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "bodyHash", "confirmationEvidenceRef"],
});
export type ConfirmTargetContractHandler = CommandHandler<ConfirmTargetContractBody, TargetContractView>;

// --- CMD040 SubmitStageReceipt --------------------------------------------------------------------------------------------------

export interface SubmitStageReceiptBody {
  /** The admitted receipt upload (a STAGE_RECEIPT artifact of the stage's project): the source-to-target identity mapping the CRM produced. */
  readonly receiptUploadRef: string;
  /** The exact package of the stage the agency imported. */
  readonly sourcePackageHash: string;
}
export const SUBMIT_STAGE_RECEIPT: CommandSpec<SubmitStageReceiptBody> = spec<SubmitStageReceiptBody>({
  id: "CMD040",
  name: "SubmitStageReceipt",
  method: "POST",
  path: "/api/v1/projects/{projectId}/import-stages/{stageId}/receipts",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "stageId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["receiptUploadRef", "sourcePackageHash"],
});
export type SubmitStageReceiptHandler = CommandHandler<SubmitStageReceiptBody, ImportStageView>;

// --- CMD041 ContinueStage --------------------------------------------------------------------------------------------------------

export interface ContinueStageBody {
  /** The stage's version (ImportStage.version: the fence between a continuation and a concurrent receipt or continuation). */
  readonly expectedVersion: number;
  /** The identity mapping digest of the validated receipt the approver was shown: a digest that is not the stage's current one is stale. */
  readonly validatedReceiptHash: string;
}
export const CONTINUE_STAGE: CommandSpec<ContinueStageBody> = spec<ContinueStageBody>({
  id: "CMD041",
  name: "ContinueStage",
  method: "POST",
  path: "/api/v1/projects/{projectId}/import-stages/{stageId}/continue",
  role: "AGENCY_APPROVER",
  scope: "AGENCY_HEADER",
  aggregateParam: "stageId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "validatedReceiptHash"],
});
export type ContinueStageHandler = CommandHandler<ContinueStageBody, ImportStageView>;

export const AUDIT_COMMANDS = Object.freeze({
  CMD018: CREATE_TARGET_CONTRACT,
  CMD019: CONFIRM_TARGET_CONTRACT,
  CMD020: START_AUDIT,
  CMD021: CANCEL_AUDIT,
  CMD022: CREATE_PLAN,
  CMD024: VALIDATE_PLAN,
  CMD040: SUBMIT_STAGE_RECEIPT,
  CMD041: CONTINUE_STAGE,
} as const);
export type AuditCommandId = keyof typeof AUDIT_COMMANDS;

export interface AuditHandlers {
  readonly CMD018: CreateTargetContractHandler;
  readonly CMD019: ConfirmTargetContractHandler;
  readonly CMD020: StartAuditHandler;
  readonly CMD021: CancelAuditHandler;
  readonly CMD022: CreatePlanHandler;
  readonly CMD024: ValidatePlanHandler;
  readonly CMD040: SubmitStageReceiptHandler;
  readonly CMD041: ContinueStageHandler;
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

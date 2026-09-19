/**
 * @kauro/application — the application layer of the Kauro platform: the public command contracts of B06, the request
 * envelope, the safe problem contract, the closed request schemas, the DTO views, and the ports orchestration needs
 * (authorizer, assurance, admission, schema validation, plan services, work inspectors, command handling).
 * It depends on @kauro/contracts and @kauro/domain only.
 */
export * from "./ports/index.js";
export type { Problem, NextAction } from "./api/problems.js";
export { PROBLEM_TYPE_PREFIX, PROBLEM_STATUS, PROBLEM_TITLE, RETRYABLE_CODES, problemOf, internalProblem, isFailureCode } from "./api/problems.js";
export type { RequestSchema, RequestSchemaCommand, RequestSchemaId } from "./api/request-schemas.js";
export { REQUEST_SCHEMA_PREFIX, REQUEST_SCHEMAS, REQUEST_SCHEMA_IDS, requestSchemaId } from "./api/request-schemas.js";
export type { CommandEnvelope, CommandResult } from "./api/envelope.js";
export { HEADERS, REQUEST_LIMITS, isSuccess } from "./api/envelope.js";
export type { AgencyView, MembershipView, EndClientView, ProjectView, PlanView, ApprovalView, ReadinessBlocker } from "./api/views.js";
export { READINESS_BLOCKERS } from "./api/views.js";
export type {
  CreateAgencyBody,
  CreateAgencyView,
  CreateAgencyHandler,
  CreateClientBody,
  CreateClientHandler,
  ArchiveClientBody,
  ArchiveClientView,
  ArchiveClientHandler,
  CreateProjectBody,
  CreateProjectHandler,
  RevisePlanBody,
  RevisePlanView,
  RevisePlanHandler,
  ApprovePlanBody,
  ApprovePlanView,
  ApprovePlanHandler,
  WithdrawApprovalBody,
  WithdrawApprovalView,
  WithdrawApprovalHandler,
  B06CommandId,
} from "./commands/contracts.js";
export { CREATE_AGENCY, CREATE_CLIENT, ARCHIVE_CLIENT, CREATE_PROJECT, REVISE_PLAN, APPROVE_PLAN, WITHDRAW_APPROVAL, B06_COMMANDS } from "./commands/contracts.js";

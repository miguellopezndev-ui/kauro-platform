/**
 * @kauro/application — the application layer of the Kauro platform: the public command contracts of B06 and their handlers,
 * the request envelope and admission, the safe problem contract, the closed request schemas and the strict schema validator,
 * the DTO views and projections, and the ports orchestration needs (authorizer, assurance, admission, schema validation, plan
 * services, work inspectors, command handling). It depends on @kauro/contracts and @kauro/domain only.
 */
export * from "./ports/index.js";
export type { Problem, NextAction } from "./api/problems.js";
export { PROBLEM_TYPE_PREFIX, PROBLEM_STATUS, PROBLEM_TITLE, RETRYABLE_CODES, problemOf, internalProblem, isFailureCode } from "./api/problems.js";
export type { RequestSchema, RequestSchemaCommand, RequestSchemaId } from "./api/request-schemas.js";
export { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX, REQUEST_SCHEMAS, REQUEST_SCHEMA_IDS, requestSchemaId } from "./api/request-schemas.js";
export type { CommandEnvelope, CommandResult, AuthenticatedSubject, CompletedResponse, AcceptedResponse } from "./api/envelope.js";
export { HEADERS, PRIVATE_CACHE_POLICY, REQUEST_LIMITS, SINGLE_VALUED_HEADERS, isSuccess } from "./api/envelope.js";
export type { AgencyView, MembershipView, EndClientView, ProjectView, PlanView, ApprovalView, ReadinessBlocker, AgencyMembershipView, TeamMemberView, Page } from "./api/views.js";
export { READINESS_BLOCKERS } from "./api/views.js";
export type { ReadinessFacts } from "./api/projections.js";
export { agencyView, membershipView, endClientView, projectView, planView, approvalView, readinessBlockersOf, agencyMembershipView, teamMemberView } from "./api/projections.js";
export type { ResourceAction } from "./api/permitted-actions.js";
export { RESOURCE_ACTIONS, clientActions, projectActions, planActions, approvalActions, controlsApproval } from "./api/permitted-actions.js";
export type { CursorBinding, CursorPosition } from "./api/cursor.js";
export { sealCursor, openCursor, isCursorKey, CURSOR_PATTERN, CURSOR_SORT, CURSOR_SNAPSHOT_POLICY } from "./api/cursor.js";
export type { ReadSpec, ReadQuery, ReadHead, ReadAdmission, ReadRequest, ReadResult, ReadHandler, ReadHandlers, ReadRuntime } from "./queries/reads.js";
export { READ_ROUTES, admitRead, admitReadQuery, runRead, createReadHandlers } from "./queries/reads.js";
export type { StrictJsonOptions, StrictJsonReason } from "./api/strict-json.js";
export { parseStrictJson, StrictJsonError } from "./api/strict-json.js";
export type { CompiledSchemaSet, SchemaBundleInput } from "./api/json-schema.js";
export { compileSchemaBundle, isCalendarDateTime, SchemaCompileError, SUPPORTED_KEYWORDS, ANNOTATION_KEYWORDS } from "./api/json-schema.js";
export type { ContractSchemaBundle } from "./api/schema-validation.js";
export { createSchemaValidator, PROBLEM_SCHEMA } from "./api/schema-validation.js";
export type {
  ResponseSchemaId,
  CommandResponseSchemaId,
  AcceptedResponseSchemaId,
  OperationalResponseSchemaId,
  ServedCommandId,
  JsonSchema,
  ViewDefinition,
  OperationalRoute,
  OperationalResponse,
  RegistryBundle,
  ResponseSchemaSet,
  ReadOperationId,
  ReadResponseSchemaId,
} from "./api/response-schemas.js";
export {
  RESPONSE_SCHEMA_PREFIX,
  RESPONSE_FIELD_VOCABULARY,
  VIEW_DEFINITIONS,
  COMMAND_RESPONSES,
  SERVED_COMMAND_IDS,
  READ_RESPONSES,
  READ_OPERATION_IDS,
  readResponseSchemaId,
  ACCEPTED_RESPONSE_SCHEMA,
  ACCEPTED_RESPONSE_SCHEMA_ID,
  OPERATIONAL_ROUTES,
  LIVENESS_RESPONSE_SCHEMA,
  READINESS_RESPONSE_SCHEMA,
  FORBIDDEN_RESPONSE_FIELDS,
  buildResponseSchemas,
  commandResponseSchemaId,
  operationalResponseSchemaId,
  declaredMembers,
  openObjects,
} from "./api/response-schemas.js";
export type { DeclaredResponse, RouteResponses } from "./api/response-contract.js";
export type { ProblemOutcome, OutcomeLayer, FieldCode } from "./api/outcomes.js";
export { COMMAND_OUTCOMES, READ_OUTCOMES, outcomeOf, outcomesByStatus } from "./api/outcomes.js";
export {
  PROBLEM_RESPONSE,
  UNROUTED_RESPONSES,
  ResponseContractViolation,
  checkReply,
  commandRouteResponses,
  operationalRouteResponses,
  readRouteResponses,
  isServedCommand,
  mediaTypeOf,
  responseIntegrityProblem,
} from "./api/response-contract.js";
export type { RawRequest, RequestHead, StructuralAdmission, AdmissionOutcome } from "./api/admission.js";
export { admitHeaders, admitStructure, envelopeOf, correlationIdOf, repeatedHeaderNames, unauthenticatedProblem } from "./api/admission.js";
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
export type { CommandRuntime, CommandContext, CommandOutcome, UnauthenticatedRequest } from "./commands/runtime.js";
export { runCommand, contextOf, identityOf, refuseUnauthenticated, recordDenialFact, ALLOW_REASONS } from "./commands/runtime.js";
export type { B06Collaborators, B06Handlers, ApprovalPreimage } from "./commands/handlers/index.js";
export {
  createB06Handlers,
  createAgencyHandler,
  createClientHandler,
  archiveClientHandler,
  createProjectHandler,
  revisePlanHandler,
  approvePlanHandler,
  withdrawApprovalHandler,
  approvalHashOf,
  LAUNCH_ASSURANCE_POLICY,
} from "./commands/handlers/index.js";
export type { InMemoryStore, InMemoryPorts, OutboxRow } from "./testing/in-memory-ports.js";
export { createInMemoryPorts, emptyStore, journalKey, fixedClock, sequentialIds } from "./testing/in-memory-ports.js";
export type { ContentFinding, DateKey, HolidayCalendar, HolidaySource, SupportWindow, Weekday } from "./support/index.js";
export {
  BOGOTA_OFFSET_MS,
  COLOMBIA_CALENDAR_VERSION,
  COLOMBIA_HOLIDAYS,
  COLOMBIA_HOLIDAY_SOURCE,
  SUPPORT_SEVERITY_BY_CATEGORY,
  SUPPORT_TIMEZONE,
  SupportPolicyError,
  colombianHolidays,
  detectRefusedContent,
  easterSundayMs,
  nextReviewAt,
  severityOf,
  supportWindowOf,
} from "./support/index.js";

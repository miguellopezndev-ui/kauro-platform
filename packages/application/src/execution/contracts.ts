/**
 * The two B08 request commands (CMD036 ExecuteProject, CMD037 CancelJob) and the one read (GetJob): input body (exactly the
 * registry fields), result view and the spec the transport and the authorizer consume. Behaviour — locks in the order of D8-LOCK-1,
 * preconditions in order, writes, events, OK/DENY/RACE — is specified in docs/design/B08-audit-approval-jobs.md §4 item 1 and §12
 * (D8-API-1); the handlers are execution/handlers.
 *
 * The routes are served through B06's pipeline in an execution unit of work (`runCommandIn`/`runReadIn`, B07 D-CMD-10): the same
 * access decision, journal reservation, assurance and denial facts as every other command.
 */
import type { JobState } from "@kauro/domain";
import type { CommandResult } from "../api/envelope.js";
import type { CommandHandler, CommandSpec } from "../ports/command-handler.js";
import type { DownloadView, JobView } from "./views.js";

function spec<Body>(s: CommandSpec<Body>): CommandSpec<Body> {
  return Object.freeze(s);
}

/** How long a caller waits before polling the status path of an accepted execution (design §12: pollAfterSeconds 10). */
export const EXECUTE_POLL_AFTER_SECONDS = 10;

// --- CMD036 ExecuteProject ------------------------------------------------------------------------------------------------------

export interface ExecuteProjectBody {
  /** The entitlement that pays for this execution: it binds the plan, the approval, the source, the target and the capability (D8-JOB-2). */
  readonly commercialAuthorizationId: string;
}
/**
 * ExecuteProject answers 202 with B06's ACCEPTED envelope: the operation is the job — operationId = the job id, state = the job's
 * state (QUEUED for a fresh one; the current state when the authorization already has a job, D8-JOB-1), statusPath =
 * /api/v1/jobs/{jobId}, pollAfterSeconds = EXECUTE_POLL_AFTER_SECONDS. The journal stores exactly this answer with status 202 and a
 * replay answers it again; progress is read at the status path (JobView). No view rides on the 202: the envelope is closed.
 */
export type ExecuteProjectAccepted = Omit<Extract<CommandResult<never>, { readonly kind: "ACCEPTED" }>, "kind" | "status"> & { readonly state: JobState };
export const EXECUTE_PROJECT: CommandSpec<ExecuteProjectBody> = spec<ExecuteProjectBody>({
  id: "CMD036",
  name: "ExecuteProject",
  method: "POST",
  path: "/api/v1/projects/{projectId}/execute",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["commercialAuthorizationId"],
});
/** A handler whose only success is the ACCEPTED answer (its CommandResult never carries a COMPLETED view). */
export type ExecuteProjectHandler = CommandHandler<ExecuteProjectBody, never>;

// --- CMD037 CancelJob ----------------------------------------------------------------------------------------------------------

export interface CancelJobBody {
  /** The job's version (Job.version: the fence between a cancellation and a concurrent transition or publication). */
  readonly expectedVersion: number;
  /** The customer's reason, a registry label; kept on the job row only, never in an event or a log (D8-CANCEL-2). */
  readonly reasonCode: string;
}
export const CANCEL_JOB: CommandSpec<CancelJobBody> = spec<CancelJobBody>({
  id: "CMD037",
  name: "CancelJob",
  method: "POST",
  path: "/api/v1/jobs/{jobId}/cancel",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "jobId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "reasonCode"],
});
export type CancelJobHandler = CommandHandler<CancelJobBody, JobView>;

// --- CMD038 AuthorizeDownload (package B16 lane L5) ------------------------------------------------------------------------------

export interface AuthorizeDownloadBody {
  /** The delivery copies to grant (stored object ids of the package's delivery artifacts), at least one, each once; answered in this order. */
  readonly artifactIds: ReadonlyArray<string>;
  /** A fresh step-up of the requester: a download is a disclosure of the customer's data. */
  readonly assuranceProofRef: string;
}
/**
 * AuthorizeDownload answers 201 with the grant: short-lived read URLs bound to the requester, valid until expiresAt =
 * least(issue + 900 s, the governing retention deadline). The journal stores the grant without its URLs (bearer secrets); every answer,
 * first or replayed, re-signs the same scope at the same expiry after re-checking the membership, the package, the project and the record.
 */
export const AUTHORIZE_DOWNLOAD: CommandSpec<AuthorizeDownloadBody> = spec<AuthorizeDownloadBody>({
  id: "CMD038",
  name: "AuthorizeDownload",
  method: "POST",
  path: "/api/v1/packages/{packageId}/download-authorizations",
  role: "AGENCY_READER",
  scope: "AGENCY_HEADER",
  aggregateParam: "packageId",
  expectedVersionRequired: false,
  stepUpRequired: true,
  authorityHashFields: [],
  fields: ["artifactIds", "assuranceProofRef"],
});
export type AuthorizeDownloadHandler = CommandHandler<AuthorizeDownloadBody, DownloadView>;

export const EXECUTION_COMMANDS = Object.freeze({
  CMD036: EXECUTE_PROJECT,
  CMD037: CANCEL_JOB,
  CMD038: AUTHORIZE_DOWNLOAD,
} as const);
export type ExecutionCommandId = keyof typeof EXECUTION_COMMANDS;

export interface ExecutionHandlers {
  readonly CMD036: ExecuteProjectHandler;
  readonly CMD037: CancelJobHandler;
  readonly CMD038: AuthorizeDownloadHandler;
}

// --- the read ------------------------------------------------------------------------------------------------------------------

/** The routes of the execution package beside its two commands: the job read (not a catalogue command; no journal entry). */
export type ExecutionRouteId = "GetJob";

export interface ExecutionRouteSpec {
  readonly method: "GET";
  readonly path: string;
  /** Registry role vocabulary (B06 D-AUTHZ-1): AGENCY_READER is any live ACTIVE membership. */
  readonly role: "AGENCY_READER";
  readonly status: 200;
  readonly view: string;
  readonly authority: string;
}

/**
 * The job read as a served manual-10 read: a GET without a body or an idempotency key, scope AGENCY_HEADER, the action token its
 * security facts carry (read-specs). Every live ACTIVE member reads a job's safe progress, whatever the role (design §12).
 */
export const EXECUTION_ROUTES: Readonly<Record<ExecutionRouteId, ExecutionRouteSpec>> = Object.freeze({
  GetJob: {
    method: "GET",
    path: "/api/v1/jobs/{jobId}",
    role: "AGENCY_READER",
    status: 200,
    view: "JobView",
    authority: "B08 design §12 (D8-API-1): the status path of ExecuteProject's ACCEPTED answer; 10 \"Long work returns 202 with operationId, current state, status URL and allowed polling guidance\"; Q8-8 (only the package id)",
  },
});

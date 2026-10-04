/**
 * Closed response views of the execution package (B08; docs/design/B08-audit-approval-jobs.md §12, D8-API-1, Q8-8), declared exactly
 * as B06 and B07 declare their own (api/response-schemas, decision D-RESP-1 of B06): a view that projects a registry contract (Job)
 * takes every selected member from the generated registry bundle, may only narrow it by adding a keyword, keeps what the registry
 * requires required, and lists every registry member it does not select as withheld with the reason. Every object is closed.
 *
 * The JobView is the safe progress of a job (10 "Responses and safe errors": never a provider identity, an object name, a prompt or
 * a customer value): the fence, the lease, the provider job id and the input binding hash stay with the control plane, and the
 * accepted output is named by its package id only (Q8-8), exposed as `publishedPackageId` once the publication committed.
 */
import { RESPONSE_FIELD_VOCABULARY, VIEW_MEMBER_KIT, type ViewDefinition } from "../api/view-kit.js";
import { ACTIVE_PROVIDER_STATES, EXECUTION_RESOURCE_ACTIONS } from "./views.js";

const { ID, VERSION, UTC, COUNT } = RESPONSE_FIELD_VOCABULARY;
const { registry, platform, NARROW_ID } = VIEW_MEMBER_KIT;

const EXECUTION_ACTIONS_SCHEMA = Object.freeze({ type: "array", maxItems: EXECUTION_RESOURCE_ACTIONS.length, items: { type: "string", enum: [...EXECUTION_RESOURCE_ACTIONS] } });
const EXECUTION_ACTIONS_DESCRIPTION =
  "The execution commands the caller may issue on this job, derived server-side from the caller's role and the job's state; informative, never authority (B06 D-PERM-1).";

/** The success reply of each execution command: CMD036 answers B06's ACCEPTED envelope (the operation is the job); CMD037 the job. */
export const EXECUTION_COMMAND_RESPONSES = Object.freeze({
  CMD036: { status: 202, view: null },
  CMD037: { status: 200, view: "JobView" },
} as const);

export const EXECUTION_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "JobView",
    description: "A processing job's safe progress (10 \"Long work returns 202 with operationId, current state, status URL and allowed polling guidance\"; design B08 §12): its state, attempt ordinal, deadlines, cancellation version and, once READY, its package id — never a provider identity, an object name, the fence or a customer value.",
    contract: "Job",
    withheld: {
      fence: "The publication fence is control-plane authority: only the fenced accepted attempt publishes, and the customer's view of progress never needs it.",
      lease: "Active ownership names a worker instance and its expiry: an operating fact of the control plane, not of the customer.",
      providerJobId: "The actual Batch or equivalent execution identity is a provider identifier; the view carries activeProviderState instead (10: no provider identity in a response).",
      inputBindingHash: "Digest of the source, plan, target, core and policy bundle: the job's admission fact, kept in its audit trail.",
      packageId: "Served as publishedPackageId, present exactly once the verified publication committed (Q8-8: only the package id).",
      deadline: "The registry's single boundary is served as two named instants: deliveryDeadlineAt (the promise) and executionDeadlineAt (the absolute execution boundary set at launch).",
    },
    members: {
      jobId: registry(true, NARROW_ID),
      projectId: registry(true, NARROW_ID),
      authorizationId: registry(true, NARROW_ID),
      state: registry(true),
      attempt: registry(true),
      version: platform(true, VERSION, "The job's optimistic version (the fence between a cancellation and a concurrent transition or publication, CMD037 expectedVersion)."),
      queuedAt: platform(true, UTC, "When the job was queued."),
      deliveryDeadlineAt: platform(true, UTC, "The instant the delivery must have happened by: the capture's completion plus forty-eight hours (D8-RET-1)."),
      executionDeadlineAt: platform(false, UTC, "The absolute execution boundary, set at launch (absent while QUEUED)."),
      cancelVersion: platform(true, COUNT, "How many cancellations the job recorded (CMD037 moves it once)."),
      cancelRequestedAt: platform(false, UTC, "When the cancellation was requested."),
      activeProviderState: platform(false, { type: "string", enum: [...ACTIVE_PROVIDER_STATES] }, "What the provider is doing for the live attempt, as far as the platform's own record shows it; absent while QUEUED and once the job ended."),
      publishedPackageId: platform(false, ID, "The accepted output, present only after the verified publication (Q8-8)."),
      permittedActions: platform(true, EXECUTION_ACTIONS_SCHEMA, EXECUTION_ACTIONS_DESCRIPTION),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);

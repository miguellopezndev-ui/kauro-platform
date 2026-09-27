/**
 * The manual-10 agency, team, client and project reads (re-check finding N16; prompts/B06 "role-specific safe DTOs"; registry
 * program.json B06 work "Provide complete DTO/state/error contracts"; 10 "Agency and team routes": "GET /agencies lists only
 * actual memberships. GET /agencies/{agencyId} returns the safe agency view", "GET /agencies/{agencyId}/members returns only team
 * information appropriate to the caller"; 10 "Client and project routes": "GET lists safe client summaries with pagination", "GET
 * /projects/{projectId} returns the current revision summary, commercial state, retention deadlines, safe progress and
 * permitted actions"; 10 "Pagination, search and exports").
 *
 * A read runs in one unit of work under the caller's own context and row-level policies, in the order of a command's access
 * (design §6.1): the subject, the identity status, and for an agency read the ACTIVE live membership read after its transition
 * lock (Authorizer.authorizeRead) — so a foreign and a nonexistent agency answer the same NOT_FOUND, and every denial is a
 * durable security fact exactly as a command's is. What differs by role is the projection: a team manager sees the whole team,
 * other members the ACTIVE team's roles; every resource view carries the permitted actions of the caller. Nothing is written but
 * a denial's fact; a read journals nothing and needs no idempotency key.
 *
 * Commercial state and retention deadlines belong to aggregates this edition does not store (CommercialAuthorization, B09;
 * the retention anchors of the source lifecycle, B07); the project read carries the current revision summary, the readiness
 * blockers (the safe progress computed from durable facts) and the permitted actions, and those packages extend the view with
 * their own members.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, ClientId, CorrelationId, IdentityContext, MembershipId, ProjectId, ResolvedMembership, TenantContext, UnitOfWork } from "@kauro/domain";
import { DomainFailure, capabilitiesOf, isUuid } from "@kauro/domain";
import type { RequestHead } from "../api/admission.js";
import { CURSOR_PATTERN, openCursor, sealCursor, type CursorBinding, type CursorPosition } from "../api/cursor.js";
import { HEADERS, SINGLE_VALUED_HEADERS, type AuthenticatedSubject } from "../api/envelope.js";
import { clientActions, projectActions } from "../api/permitted-actions.js";
import { problemOf, type Problem } from "../api/problems.js";
import { agencyMembershipView, agencyView, endClientView, projectView, readinessBlockersOf, teamMemberView } from "../api/projections.js";
import type { ReadOperationId } from "../api/response-schemas.js";
import type { AgencyMembershipView, AgencyView, EndClientView, Page, ProjectView, TeamMemberView } from "../api/views.js";
import { REQUEST_LIMITS } from "../api/envelope.js";
import { recordDenialFact, type CommandRuntime } from "../commands/runtime.js";
import { AUTHORIZATION_POLICY_VERSION, type AuthorizationDecision } from "../ports/authorizer.js";

export interface ReadSpec<Id extends string = ReadOperationId> {
  readonly operationId: Id;
  readonly method: "GET";
  /** OpenAPI path template. */
  readonly path: string;
  /** The action token of the read's security facts. */
  readonly action: string;
  /** Where the agency selector comes from: none (the caller's own memberships), the path, or the active-agency header. */
  readonly scope: "NONE" | "AGENCY_PATH" | "AGENCY_HEADER";
  /** Whether the read is a list with limit and cursor. */
  readonly paginated: boolean;
  readonly summary: string;
  /** The manual section that requires the read. */
  readonly authority: string;
}

function readSpec(s: ReadSpec): ReadSpec {
  return Object.freeze(s);
}

/** The five reads, in route order. */
export const READ_ROUTES: Readonly<Record<ReadOperationId, ReadSpec>> = Object.freeze({
  ListAgencies: readSpec({
    operationId: "ListAgencies",
    method: "GET",
    path: "/api/v1/agencies",
    action: "LIST_AGENCIES",
    scope: "NONE",
    paginated: true,
    summary: "The caller's actual memberships and their agencies",
    authority: '10 "Agency and team routes": "GET /agencies lists only actual memberships"',
  }),
  GetAgency: readSpec({
    operationId: "GetAgency",
    method: "GET",
    path: "/api/v1/agencies/{agencyId}",
    action: "GET_AGENCY",
    scope: "AGENCY_PATH",
    paginated: false,
    summary: "The safe agency view with the caller's capabilities",
    authority: '10 "Agency and team routes": "GET /agencies/{agencyId} returns the safe agency view"',
  }),
  ListMembers: readSpec({
    operationId: "ListMembers",
    method: "GET",
    path: "/api/v1/agencies/{agencyId}/members",
    action: "LIST_MEMBERS",
    scope: "AGENCY_PATH",
    paginated: true,
    summary: "The agency's team, as the caller may see it",
    authority: '10 "Agency and team routes": "GET /agencies/{agencyId}/members returns only team information appropriate to the caller"',
  }),
  ListClients: readSpec({
    operationId: "ListClients",
    method: "GET",
    path: "/api/v1/agencies/{agencyId}/clients",
    action: "LIST_CLIENTS",
    scope: "AGENCY_PATH",
    paginated: true,
    summary: "The agency's safe client summaries",
    authority: '10 "Client and project routes": "GET lists safe client summaries with pagination"',
  }),
  GetProject: readSpec({
    operationId: "GetProject",
    method: "GET",
    path: "/api/v1/projects/{projectId}",
    action: "GET_PROJECT",
    scope: "AGENCY_HEADER",
    paginated: false,
    summary: "A project with its current revision summary, readiness blockers and permitted actions",
    authority: '10 "Client and project routes": "GET /projects/{projectId} returns the current revision summary, commercial state, retention deadlines, safe progress and permitted actions"',
  }),
});

// --- the query (a closed schema too) ------------------------------------------------------------------------------------------

export interface ReadQuery {
  /** Page size: the R2 policy's api.pageDefault when absent, at most api.pageMaximum. */
  readonly limit: number;
  readonly cursor: string | null;
}

const LIMIT = /^[1-9][0-9]{0,2}$/;
const CURSOR_SHAPE = new RegExp(CURSOR_PATTERN);
const QUERY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function schemaViolation(field: string, code: "UNKNOWN_FIELD" | "TYPE" | "FORMAT" | "RANGE"): DomainFailure {
  return new DomainFailure("INVALID_REQUEST", "read query refused", { reason: "SCHEMA_VIOLATION", fields: [{ field, code }] });
}

/**
 * Admits a read's query string (10 "Request envelope": closed schemas, no coercion beyond the declared integer, extra members
 * reject): a list takes limit (an integer 1..api.pageMaximum, default api.pageDefault) and cursor (the opaque token of a previous
 * page); any other read takes nothing. A repeated member is refused. A cursor that is not of the cursor's shape cannot have been
 * issued here and is CURSOR_INVALID, as is one that does not verify (checked by the read, after access).
 */
export function admitReadQuery(spec: ReadSpec<string>, query: Readonly<Record<string, unknown>>): ReadQuery {
  let limit: number = REQUEST_LIMITS.pageDefault;
  let cursor: string | null = null;
  for (const [name, value] of Object.entries(query)) {
    const field = QUERY_NAME.test(name) ? `query.${name}` : "query";
    if (!spec.paginated || (name !== "limit" && name !== "cursor")) throw schemaViolation(field, "UNKNOWN_FIELD");
    if (typeof value !== "string") throw schemaViolation(field, "TYPE");
    if (name === "limit") {
      if (!LIMIT.test(value)) throw schemaViolation(field, "FORMAT");
      limit = Number(value);
      if (limit > REQUEST_LIMITS.pageMaximum) throw schemaViolation(field, "RANGE");
    } else {
      if (!CURSOR_SHAPE.test(value)) throw new DomainFailure("INVALID_REQUEST", "cursor is not of the cursor's shape", { reason: "CURSOR_INVALID" });
      cursor = value;
    }
  }
  return { limit, cursor };
}

/** What a read's admission needs from the transport: the request head, its route parameters and its parsed query string. */
export interface ReadHead extends RequestHead {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, unknown>>;
}

export type ReadAdmission =
  | { readonly kind: "ADMITTED"; readonly correlationId: CorrelationId; readonly agencyId: AgencyId | null; readonly path: Readonly<Record<string, string>>; readonly query: ReadQuery }
  | { readonly kind: "PROBLEM"; readonly problem: Problem };

/**
 * Structural admission of a read, in the order of a command's (10 "Request envelope"): a repeated single-valued envelope header
 * (R41), the path ids, the closed query, the agency selector. The authenticated subject and the access decision follow; nothing
 * here reads a row or echoes a value.
 */
export function admitRead(spec: ReadSpec<string>, head: ReadHead): ReadAdmission {
  const correlationId = head.correlationId;
  try {
    if (head.repeatedHeaders.some((name) => SINGLE_VALUED_HEADERS.has(name))) throw new DomainFailure("INVALID_REQUEST", "request refused: HEADER_REPEATED", { reason: "HEADER_REPEATED" });
    const path: Record<string, string> = {};
    for (const name of spec.path.match(/\{([a-zA-Z]+)\}/g)?.map((m) => m.slice(1, -1)) ?? []) {
      const value = head.params[name];
      if (value === undefined || !isUuid(value)) throw new DomainFailure("INVALID_REQUEST", "request refused: PATH_ID_INVALID", { reason: "PATH_ID_INVALID", fields: [{ field: name, code: "FORMAT" }] });
      path[name] = value;
    }
    const query = admitReadQuery(spec, head.query);
    let agencyId: AgencyId | null = null;
    if (spec.scope === "AGENCY_PATH") agencyId = path["agencyId"] as AgencyId;
    else if (spec.scope === "AGENCY_HEADER") {
      const selector = head.headers[HEADERS.agency];
      if (selector === undefined || !isUuid(selector)) throw new DomainFailure("INVALID_REQUEST", "request refused: AGENCY_SELECTOR_INVALID", { reason: "AGENCY_SELECTOR_INVALID" });
      agencyId = selector as AgencyId;
    }
    return { kind: "ADMITTED", correlationId, agencyId, path, query };
  } catch (e) {
    if (e instanceof DomainFailure) return { kind: "PROBLEM", problem: problemOf(e, correlationId) };
    throw e;
  }
}

// --- the runtime -----------------------------------------------------------------------------------------------------------------

export interface ReadRequest {
  readonly correlationId: CorrelationId;
  readonly subject: AuthenticatedSubject;
  /** The agency selector (path or header); null for the caller's own memberships (ListAgencies). */
  readonly agencyId: AgencyId | null;
  /** Path ids, validated as ids by the transport. */
  readonly path: Readonly<Record<string, string>>;
  readonly query: ReadQuery;
}

export type ReadResult<View> = { readonly kind: "READ"; readonly view: View } | { readonly kind: "PROBLEM"; readonly problem: Problem };

export interface ReadHandler<View> {
  readonly spec: ReadSpec;
  execute(request: ReadRequest): Promise<ReadResult<View>>;
}

/** What every read needs: the command runtime's unit of work, authorizer and clock, and the key its cursors are sealed with. */
export interface ReadRuntime extends Pick<CommandRuntime, "unitOfWork" | "authorizer" | "clock"> {
  readonly cursorKey: Uint8Array;
}

interface ReadContext {
  /** The caller's ACTIVE membership in the selected agency; null for ListAgencies. */
  readonly membership: ResolvedMembership | null;
}

/** An access denial, thrown so the unit of work rolls back and recognised afterwards as a decision to record. */
class ReadDenied extends DomainFailure {
  constructor(operationId: ReadOperationId, readonly decision: Extract<AuthorizationDecision, { kind: "DENY" }>) {
    super(decision.code, `${operationId} denied: ${decision.reason}`, { reason: decision.reason });
    this.name = "ReadDenied";
  }
}

export async function runRead<View>(spec: ReadSpec, runtime: ReadRuntime, request: ReadRequest, body: (uow: UnitOfWork, ctx: ReadContext) => Promise<View>): Promise<ReadResult<View>> {
  const userId = request.subject.identity.userId;
  if (spec.scope !== "NONE" && request.agencyId === null) {
    return { kind: "PROBLEM", problem: problemOf(new DomainFailure("INVALID_REQUEST", `${spec.operationId} needs an agency selector`, { reason: "TENANT_CONTEXT_MISSING" }), request.correlationId) };
  }
  const context: TenantContext | IdentityContext =
    spec.scope === "NONE" || request.agencyId === null
      ? { kind: "IDENTITY", userId, correlationId: request.correlationId }
      : { kind: "TENANT", agencyId: request.agencyId, userId, correlationId: request.correlationId };
  try {
    const view = await runtime.unitOfWork.run(context, async (uow) => {
      const access = await runtime.authorizer.authorizeRead(uow, { identity: request.subject.identity, agencyId: spec.scope === "NONE" ? null : request.agencyId });
      if (access.kind === "DENY") throw new ReadDenied(spec.operationId, access);
      return body(uow, { membership: access.membership });
    });
    return { kind: "READ", view };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (e instanceof ReadDenied) await recordDenialFact(runtime, context, spec.action, request.correlationId, e, e.decision.policyVersion);
    else if (e.code === "NOT_AUTHORIZED" || e.code === "AUTHENTICATION_REQUIRED") await recordDenialFact(runtime, context, spec.action, request.correlationId, e, AUTHORIZATION_POLICY_VERSION);
    return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
  }
}

function member(ctx: ReadContext): ResolvedMembership {
  if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency read was authorized without a membership");
  return ctx.membership;
}

function cursorInvalid(): DomainFailure {
  return new DomainFailure("INVALID_REQUEST", "the cursor was not issued for this request", { reason: "CURSOR_INVALID" });
}

/** The keyset position a request's cursor names for exactly this binding, or none for a first page. */
function positionOf(runtime: ReadRuntime, binding: CursorBinding, cursor: string | null): CursorPosition | undefined {
  if (cursor === null) return undefined;
  const position = openCursor(runtime.cursorKey, binding, cursor);
  if (position === null) throw cursorInvalid();
  return position;
}

/** A page: the cursor of the next page when this one is full (the next may be empty: "when there may be one"). */
function pageOf<Row, Item>(runtime: ReadRuntime, binding: CursorBinding, rows: ReadonlyArray<Row>, limit: number, item: (row: Row) => Item, keyOf: (row: Row) => CursorPosition): Page<Item> {
  const last = rows.at(-1);
  return {
    items: rows.map(item),
    ...(rows.length === limit && last !== undefined ? { nextCursor: sealCursor(runtime.cursorKey, binding, keyOf(last)) } : {}),
  };
}

// --- the handlers -------------------------------------------------------------------------------------------------------------------

export interface ReadHandlers {
  readonly ListAgencies: ReadHandler<Page<AgencyMembershipView>>;
  readonly GetAgency: ReadHandler<AgencyView>;
  readonly ListMembers: ReadHandler<Page<TeamMemberView>>;
  readonly ListClients: ReadHandler<Page<EndClientView>>;
  readonly GetProject: ReadHandler<ProjectView>;
}

export function createReadHandlers(runtime: ReadRuntime): ReadHandlers {
  const listAgencies: ReadHandler<Page<AgencyMembershipView>> = {
    spec: READ_ROUTES.ListAgencies,
    execute: (request) =>
      runRead(READ_ROUTES.ListAgencies, runtime, request, async (uow) => {
        const userId = request.subject.identity.userId;
        const binding: CursorBinding = { operation: "ListAgencies", userId, agencyId: null, filter: "" };
        const after = positionOf(runtime, binding, request.query.cursor);
        const rows = await uow.agencies.pageOwnMemberships(userId, { limit: request.query.limit, ...(after !== undefined ? { after: { createdAt: after.createdAt as UtcInstant, id: after.id as AgencyId } } : {}) });
        return pageOf(runtime, binding, rows, request.query.limit, (r) => agencyMembershipView(r.agency, r.membership), (r) => ({ createdAt: r.agency.createdAt, id: r.agency.agencyId }));
      }),
  };

  const getAgency: ReadHandler<AgencyView> = {
    spec: READ_ROUTES.GetAgency,
    execute: (request) =>
      runRead(READ_ROUTES.GetAgency, runtime, request, async (uow, ctx) => {
        const membership = member(ctx);
        const agency = await uow.agencies.get(membership.agencyId);
        if (!agency) throw new DomainFailure("INTEGRITY_FAILURE", "the agency of a live membership is not visible");
        return agencyView(agency, membership.role);
      }),
  };

  const listMembers: ReadHandler<Page<TeamMemberView>> = {
    spec: READ_ROUTES.ListMembers,
    execute: (request) =>
      runRead(READ_ROUTES.ListMembers, runtime, request, async (uow, ctx) => {
        const membership = member(ctx);
        // a caller who manages the team sees every membership and its lifecycle; anyone else the ACTIVE team's roles
        const managesTeam = capabilitiesOf(membership.role).includes("MANAGE_TEAM");
        const binding: CursorBinding = { operation: "ListMembers", userId: membership.userId, agencyId: membership.agencyId, filter: managesTeam ? "every-state" : "active" };
        const after = positionOf(runtime, binding, request.query.cursor);
        const rows = await uow.memberships.pageTeam(membership.agencyId, managesTeam, {
          limit: request.query.limit,
          ...(after !== undefined ? { after: { createdAt: after.createdAt as UtcInstant, id: after.id as MembershipId } } : {}),
        });
        return pageOf(runtime, binding, rows, request.query.limit, (m) => teamMemberView(m, membership.membershipId, managesTeam), (m) => ({ createdAt: m.createdAt, id: m.membershipId }));
      }),
  };

  const listClients: ReadHandler<Page<EndClientView>> = {
    spec: READ_ROUTES.ListClients,
    execute: (request) =>
      runRead(READ_ROUTES.ListClients, runtime, request, async (uow, ctx) => {
        const membership = member(ctx);
        const binding: CursorBinding = { operation: "ListClients", userId: membership.userId, agencyId: membership.agencyId, filter: "" };
        const after = positionOf(runtime, binding, request.query.cursor);
        const agency = await uow.agencies.get(membership.agencyId);
        if (!agency) throw new DomainFailure("INTEGRITY_FAILURE", "the agency of a live membership is not visible");
        const rows = await uow.endClients.list(membership.agencyId, {
          limit: request.query.limit,
          ...(after !== undefined ? { after: { createdAt: after.createdAt as UtcInstant, clientId: after.id as ClientId } } : {}),
        });
        return pageOf(runtime, binding, rows, request.query.limit, (c) => endClientView(c, clientActions(membership.role, c, agency)), (c) => ({ createdAt: c.createdAt, id: c.clientId }));
      }),
  };

  const getProject: ReadHandler<ProjectView> = {
    spec: READ_ROUTES.GetProject,
    execute: (request) =>
      runRead(READ_ROUTES.GetProject, runtime, request, async (uow, ctx) => {
        const membership = member(ctx);
        const projectId = request.path["projectId"] as ProjectId;
        const project = await uow.projects.get(projectId);
        if (!project || project.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "project not visible");
        const revision = await uow.revisions.get(project.currentRevisionId);
        const agency = await uow.agencies.get(project.agencyId);
        const capability = await uow.capabilities.get(project.capabilityId);
        const targetContract = await uow.targetContracts.findLatestForProject(projectId);
        const plan = await uow.plans.findCurrentForProject(projectId);
        if (!revision || !agency) throw new DomainFailure("INTEGRITY_FAILURE", "a visible project's current revision or agency is not visible");
        const blockers = readinessBlockersOf({ agency, capability, currentRevision: revision, targetContract, plan });
        return projectView(project, revision, blockers, projectActions());
      }),
  };

  return Object.freeze({ ListAgencies: listAgencies, GetAgency: getAgency, ListMembers: listMembers, ListClients: listClients, GetProject: getProject });
}

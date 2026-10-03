/**
 * The request side of the payments workflow (package B09, implementation mandate M4; design §3.4, §6.1, §8, §8.3; decisions
 * D-REQ-B1..B7 of docs/design/B09-payments-fiscal.md): what its handlers and reads run on, and the two runners the provider-effect
 * runtime of the commerce core does not cover.
 *
 *  - The request handlers' units of work (kauro_app): TENANT for an agency member's commands and reads, OPERATOR for a corporate
 *    owner's review of a refund; the payment service's units of work (kauro_payment, SERVICE) for the settle step (T3) of CMD028
 *    and CMD029 — the only writer of what a provider reported (D-AUTH-B4, D-PROTO-B5).
 *  - The collaborators a deployment binds (D-REQ-B1): the payment provider adapter, the purchased-subject reader and the request
 *    queries of the persistence adapter, and the platform ports of the packages B09 meets at integration (B08's deliverable
 *    capacity, B07's source availability). An unbound provider adapter or payment service answers INTEGRITY_FAILURE
 *    PROVIDER_SERVICES_UNAVAILABLE inside the unit of work with nothing written (design §8 CMD028; a deployment before B15);
 *    an unbound capacity port is "unanswered" and answers CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE (D-CAP-B1); an
 *    unbound source-availability reader leaves the quote's own promise (Quote.sourceAvailableUntil, set by the reader at issuance,
 *    D-QUOTE-B7) as the effective deadline, with the revision's SEALED state read after its transition lock.
 *  - `runCommerceCommand`: one command in one unit of work in B06's pipeline order (D-PIPE-1) — the access decision (the B06
 *    authorizer for an agency member, the commerce authorizer for a corporate owner), the journal reservation or the replay of the
 *    journaled result, the command's own locked preconditions, assurance and writes, the journaled response — with every
 *    authorization denial recorded as a durable fact in the stream the recording transaction can prove (B06 D-FACT-1; an operator's
 *    facts in its own identity stream naming the agency it adopted, D-FACT-B1, D-REQ-B5).
 *  - `runCommerceRead`: a read in B06's read discipline (access decision, the caller's policies, a durable fact of a denial).
 */
import type { CommandId, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  CaptureId,
  CausationId,
  Clock,
  CommerceUnitOfWork,
  CommerceUnitOfWorkFactory,
  FailureCode,
  IdGenerator,
  IdempotencyIdentity,
  OperatorContext,
  PaymentOrderId,
  PaymentOrderState,
  ProjectId,
  QuoteId,
  RefundPolicyId,
  ResolvedMembership,
  TenantContext,
  UserId,
} from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, DomainFailure, IdempotencyConflictFailure, actorOf, commandRequestDigest } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { problemOf, type Problem } from "../../api/problems.js";
import type { ReadRequest, ReadResult, ReadSpec } from "../../queries/reads.js";
import { recordDenialFact } from "../../commands/runtime.js";
import type { AuthorizationDecision, Authorizer } from "../../ports/authorizer.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import type { CommandSpec } from "../../ports/command-handler.js";
import type { CommerceCommandSpec } from "../contracts.js";
import type { CommerceAuthorizer, CommerceDenial, DeliveryCapacityPort, PaymentProviderAdapter, SourceAvailabilityReader } from "../ports.js";
import type { ProtocolPoint } from "../core/provider-effects.js";
import type { PurchasedSubjectReader } from "../core/subject.js";
import type { DurableOperation } from "../protocol.js";
import type { CommerceReadOperationId } from "../response-schemas.js";

// --- the ports the request side reads through ------------------------------------------------------------------------------------

/**
 * The request side's queries beyond the repository ports (D-REQ-B2), run in the caller's commerce unit of work under its policies;
 * the persistence adapter implements them (@kauro/persistence PgCommerceRequestReads) and the api composition binds them.
 */
export interface CommerceRequestQueries {
  /** The shared half of a commerce transition subject the command relies on without changing it (design §6.2), held to COMMIT. */
  awaitTransition(uow: CommerceUnitOfWork, kind: "kauro.quotes" | "kauro.capture_facts" | "kauro.commercial_authorizations", subject: string): Promise<void>;
  /** The orders of a quote, oldest first. */
  ordersOfQuote(uow: CommerceUnitOfWork, quoteId: QuoteId): Promise<ReadonlyArray<{ readonly orderId: PaymentOrderId; readonly state: PaymentOrderState }>>;
  /** A COMPLETED capture paying an order of the quote, if any (ALREADY_PAID). */
  completedCaptureOfQuote(uow: CommerceUnitOfWork, quoteId: QuoteId): Promise<CaptureId | null>;
  /** The latest COMPLETED capture of the project's orders, if any (CMD031). */
  latestCompletedCaptureOfProject(uow: CommerceUnitOfWork, projectId: ProjectId): Promise<CaptureId | null>;
  /** The ACTIVE standing refund policies (GetRefundReview lists those that cover the proposal). */
  activeRefundPolicies(uow: CommerceUnitOfWork, limit: number): Promise<ReadonlyArray<RefundPolicyId>>;
}

/** A hold of the provider-effect protocol (tests only): a throw ends the run like a process death at that point (D-REQ-B6). */
export type ProtocolHold = (command: "CMD028" | "CMD029", point: ProtocolPoint, operation: DurableOperation | null) => Promise<void>;

/** What a deployment binds for the request side (D-REQ-B1). */
export interface CommerceRequestCollaborators {
  /** The payment service's units of work (SERVICE contexts on the kauro_payment pool) for the settle step; null: not bound. */
  readonly payment: CommerceUnitOfWorkFactory | null;
  /** The verified service identity the settle step runs as (a SERVICE context's serviceId; D-CTX-B1). */
  readonly paymentServiceId: string;
  /** The payment provider adapter (B15's; a labelled contract fake in tests); null: not bound in this deployment. */
  readonly provider: PaymentProviderAdapter | null;
  readonly subjects: PurchasedSubjectReader;
  readonly queries: CommerceRequestQueries;
  /** B08's admission (DeliveryCapacityPort; D-CAP-B1); null: not bound, which is "unanswered". */
  readonly capacity: DeliveryCapacityPort | null;
  /** B07's source availability (SourceAvailabilityReader; D-QUOTE-B7); null: the quote's own promise stands. */
  readonly sources: SourceAvailabilityReader | null;
  /** Test-only hold of the provider-effect protocol (never bound by a deployment; D-REQ-B6). */
  readonly protocolHold?: ProtocolHold;
}

/** What every request-side handler and read needs beside its collaborators. */
export interface CommerceRequestRuntime {
  /** The request handlers' commerce units of work (TENANT, OPERATOR and ANONYMOUS contexts on kauro_app). */
  readonly unitOfWork: CommerceUnitOfWorkFactory;
  /** B06's authorizer: an agency member's access (AGENCY_BILLING for commands, any role for reads). */
  readonly authorizer: Authorizer;
  /** The corporate owner's access and assurance (D-AUTHZ-B1..B3; commerce/core createCommerceAuthorizer). */
  readonly commerceAuthorizer: CommerceAuthorizer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

// --- failures ------------------------------------------------------------------------------------------------------------------------

/** The failure of a provider effect this deployment cannot perform (design §8: "an adapter bound", INTEGRITY_FAILURE, nothing written). */
export function providerServicesUnavailable(): DomainFailure {
  return new DomainFailure("INTEGRITY_FAILURE", "no payment provider adapter or payment service is bound in this deployment", { reason: "PROVIDER_SERVICES_UNAVAILABLE" });
}

/** An access denial of the B06 authorizer, thrown so the unit of work rolls back and recognised afterwards as a decision to record. */
export class CommerceAccessDenied extends DomainFailure {
  constructor(
    what: string,
    readonly policyVersion: string,
    code: FailureCode,
    reason: DomainFailure["details"]["reason"] | null,
  ) {
    super(code, `${what} denied: ${reason ?? code}`, reason === null || reason === undefined ? {} : { reason });
    this.name = "CommerceAccessDenied";
  }

  static of(what: string, decision: Extract<AuthorizationDecision, { kind: "DENY" }> | CommerceDenial): CommerceAccessDenied {
    return new CommerceAccessDenied(what, decision.policyVersion, decision.code, decision.reason);
  }
}

const CONFLICT_CODES: ReadonlySet<FailureCode> = new Set(["STALE_VERSION", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "OPERATION_CANCELLED"]);
/** Handler-level failures that are authorization facts; every access denial is one too (B06 runCommand). */
export const DENIAL_CODES: ReadonlySet<FailureCode> = new Set(["AUTHENTICATION_REQUIRED", "ASSURANCE_REQUIRED", "NOT_AUTHORIZED"]);

export function resultOf<View>(failure: DomainFailure, correlationId: string): CommandResult<View> {
  const problem = problemOf(failure, correlationId);
  if (CONFLICT_CODES.has(failure.code)) return { kind: "CONFLICT", problem };
  if (failure.code === "CAPACITY_UNAVAILABLE") return { kind: "UNAVAILABLE", problem };
  return { kind: "REJECTED", problem };
}

// --- contexts, identities, admission -------------------------------------------------------------------------------------------------

/** An agency member's TENANT context (admission guarantees the selector of an AGENCY_HEADER command). */
export function tenantContextOf(envelope: Pick<CommandEnvelope<unknown>, "agencyId" | "userId" | "correlationId">): TenantContext {
  if (envelope.agencyId === null) throw new DomainFailure("INVALID_REQUEST", "an agency command needs its agency selector", { reason: "TENANT_CONTEXT_MISSING" });
  return { kind: "TENANT", agencyId: envelope.agencyId, userId: envelope.userId, correlationId: envelope.correlationId };
}

export function operatorContextOf(envelope: Pick<CommandEnvelope<unknown>, "userId" | "correlationId">): OperatorContext {
  return { kind: "OPERATOR", userId: envelope.userId, correlationId: envelope.correlationId };
}

/**
 * What the runner and the identity helpers read of a command: its id and where its journal row lives. A B09 command spec fits it, and
 * so does a B10 one (commercial/agency: the agency lifecycle runs on the same pipeline; package B10).
 */
export interface RunnableCommand {
  readonly id: string;
  readonly journalScope: "TENANT" | "OPERATOR_IDENTITY" | "NONE";
}

/** The idempotency identity of a command: the agency's row, or — for an operator — the operator's own identity-owned row (D-IDEM-B2). */
export function commerceIdentityOf<Body>(spec: RunnableCommand, envelope: CommandEnvelope<Body>): IdempotencyIdentity {
  return {
    environment: envelope.environment,
    actor: { kind: "USER", userId: envelope.userId },
    agencyId: spec.journalScope === "OPERATOR_IDENTITY" ? null : envelope.agencyId,
    operation: spec.id as CommandId,
    key: envelope.idempotencyKey,
  };
}

export function commerceDigestOf<Body>(spec: Pick<RunnableCommand, "id">, envelope: CommandEnvelope<Body>): Sha256Hex {
  return commandRequestDigest({ operation: spec.id as CommandId, aggregate: envelope.path, body: envelope.body });
}

/**
 * The spec the transport's admission reads (@kauro/application admitStructure: path ids, the agency selector, the closed request
 * schema): an agency command selects its agency by the X-Kauro-Agency header; a command keyed by its stored operation carries no
 * selector (its scope is the operation's, D-SCOPE-B1).
 */
export function admissionSpecOf<Body>(spec: CommerceCommandSpec<Body>): CommandSpec<Body> {
  return Object.freeze({
    id: spec.id as CommandId,
    name: spec.name,
    method: spec.method,
    path: spec.path,
    role: spec.role,
    scope: spec.scope === "AGENCY_HEADER" ? "AGENCY_HEADER" : "NONE",
    aggregateParam: spec.aggregateParam,
    expectedVersionRequired: spec.expectedVersionRequired,
    stepUpRequired: false,
    authorityHashFields: spec.authorityHashFields,
    fields: spec.fields,
  });
}

// --- denial facts -------------------------------------------------------------------------------------------------------------------

/**
 * The durable fact of an operator's denial (D-FACT-B1, D-REQ-B5), in its own transaction: the operator's identity stream (agency
 * NULL), naming the agency it had adopted when one was (a name, never a reference).
 */
export async function recordOperatorDenial(runtime: Pick<CommerceRequestRuntime, "unitOfWork" | "clock">, context: OperatorContext, action: string, failure: DomainFailure, policyVersion: string, requestedAgencyId: AgencyId | null): Promise<void> {
  await runtime.unitOfWork.run(context, async (uow) => {
    await uow.securityEvents.append({
      agencyId: null,
      requestedAgencyId,
      actor: actorOf(context),
      action,
      outcome: "DENY",
      reasonCode: failure.details.reason ?? failure.code,
      policyVersion,
      assuranceClass: failure.code === "ASSURANCE_REQUIRED" ? "STEP_UP" : "SESSION",
      correlationId: context.correlationId,
      occurredAt: runtime.clock.now(),
    });
  });
}

/** Records the fact of a denial in the stream its context can prove (a member's agency or identity stream, an operator's identity stream). */
export async function recordCommerceDenial(runtime: Pick<CommerceRequestRuntime, "unitOfWork" | "clock">, context: TenantContext | OperatorContext, action: string, failure: DomainFailure, requestedAgencyId: AgencyId | null): Promise<void> {
  const policyVersion = failure instanceof CommerceAccessDenied ? failure.policyVersion : context.kind === "OPERATOR" ? COMMERCE_POLICY_VERSION : AUTHORIZATION_POLICY_VERSION;
  if (context.kind === "OPERATOR") return recordOperatorDenial(runtime, context, action, failure, policyVersion, requestedAgencyId);
  return recordDenialFact(runtime, context, action, context.correlationId, failure, policyVersion);
}

// --- one command in one unit of work -------------------------------------------------------------------------------------------------

/** What a command's body answers: its status, the view to journal, the version of the aggregate it names and the resource link. */
export interface CommerceOutcome<View> {
  readonly status: 200 | 201;
  readonly view: View;
  readonly version: number;
  readonly resourceKind: string;
  readonly resourceId: string;
  /** An ALLOW fact of the effect's authorization (a step-up or a standing policy), committed with the effect or not at all. */
  readonly allowFact?: { readonly reasonCode: string; readonly assuranceClass: "SESSION" | "STEP_UP"; readonly policyVersion: string };
}

export interface CommerceCommandRun<Body, View> {
  readonly command: RunnableCommand;
  readonly envelope: CommandEnvelope<Body>;
  readonly context: TenantContext | OperatorContext;
  /** The access decision, before the reservation (B06 D-PIPE-1); throws a DomainFailure to deny. */
  access(uow: CommerceUnitOfWork): Promise<void>;
  /** The locked preconditions, the assurance of a new execution and the writes, after the reservation. */
  body(uow: CommerceUnitOfWork, causationId: CausationId, now: UtcInstant): Promise<CommerceOutcome<View>>;
}

/** The version a journaled view carries: at its top level or on the aggregate it names (refund, order, quote; the agency of B10's lifecycle views). */
export function versionOfView(view: unknown): number {
  if (typeof view === "object" && view !== null) {
    const v = view as Record<string, unknown>;
    if (typeof v["version"] === "number") return v["version"];
    for (const key of ["refund", "order", "quote", "agency"]) {
      const inner = v[key];
      if (typeof inner === "object" && inner !== null && typeof (inner as Record<string, unknown>)["version"] === "number") return (inner as Record<string, unknown>)["version"] as number;
    }
  }
  throw new DomainFailure("INTEGRITY_FAILURE", "journaled response carries no aggregate version");
}

class Replayed {
  constructor(readonly status: 200 | 201, readonly view: unknown) {}
}

/**
 * Runs one command without a provider effect in one commerce unit of work (CMD031, CMD032): access → journal reserve (or the
 * replay of the journaled result, the conflict of another digest, the pending entry) → the body (assurance, locked preconditions,
 * writes, events) → the ALLOW fact of its authorization → the journaled response → COMMIT. A DomainFailure rolls everything back
 * (the reservation too: a rejection leaves no journal row, B06 D-IDEM-2) and becomes the CONFLICT / REJECTED / UNAVAILABLE result;
 * an authorization denial is recorded in its own transaction afterwards. Any other exception propagates (INTERNAL_ERROR by
 * correlation id at the transport).
 */
export async function runCommerceCommand<Body, View>(runtime: CommerceRequestRuntime, run: CommerceCommandRun<Body, View>): Promise<CommandResult<View>> {
  const { envelope, context, command } = run;
  const identity = commerceIdentityOf(command, envelope);
  const digest = commerceDigestOf(command, envelope);
  let accessDenied = false;
  let adopted: AgencyId | null = context.kind === "TENANT" ? context.agencyId : null;
  try {
    const out = await runtime.unitOfWork.run(context, async (uow): Promise<{ readonly outcome: CommerceOutcome<View> } | Replayed> => {
      try {
        await run.access(uow);
      } catch (e) {
        accessDenied = e instanceof DomainFailure;
        throw e;
      }
      adopted = uow.commerceScope;
      const reservation = await uow.journal.reserve(identity, digest, envelope.correlationId);
      if (reservation.kind === "REPLAY") {
        const status = reservation.entry.responseStatus;
        if ((status !== 200 && status !== 201) || reservation.entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
        return new Replayed(status, reservation.entry.responseBody);
      }
      if (reservation.kind === "CONFLICT") throw new IdempotencyConflictFailure();
      if (reservation.kind === "PENDING") throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
      const now = runtime.clock.now();
      const outcome = await run.body(uow, reservation.entryId as string as CausationId, now);
      if (outcome.allowFact !== undefined) {
        // the authorization of this effect is a durable fact, committed with it: an agency member's in the agency stream, an
        // operator's in its identity stream naming the agency it adopted (D-FACT-B1)
        await uow.securityEvents.append({
          agencyId: context.kind === "TENANT" ? context.agencyId : null,
          requestedAgencyId: context.kind === "TENANT" ? null : uow.commerceScope,
          actor: actorOf(context),
          action: command.id,
          outcome: "ALLOW",
          reasonCode: outcome.allowFact.reasonCode,
          policyVersion: outcome.allowFact.policyVersion,
          assuranceClass: outcome.allowFact.assuranceClass,
          correlationId: envelope.correlationId,
          occurredAt: now,
        });
      }
      const committed = await uow.journal.commit(reservation.entryId, { responseStatus: outcome.status, responseBody: outcome.view, resourceKind: outcome.resourceKind, resourceId: outcome.resourceId });
      if (committed.state !== "COMMITTED" || committed.responseStatus !== outcome.status || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
      return { outcome: { ...outcome, view: committed.responseBody as View } };
    });
    if (out instanceof Replayed) return { kind: "COMPLETED", status: out.status, view: out.view as View, version: versionOfView(out.view), replayed: true };
    return { kind: "COMPLETED", status: out.outcome.status, view: out.outcome.view, version: out.outcome.version, replayed: false };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (accessDenied || DENIAL_CODES.has(e.code)) await recordCommerceDenial(runtime, context, command.id, e, adopted);
    return resultOf<View>(e, envelope.correlationId);
  }
}

// --- reads ---------------------------------------------------------------------------------------------------------------------------

/** A served B09 read (design §8.3, §10): its route, the action token of its facts, and the scope its caller is admitted by. */
export interface CommerceReadSpec {
  readonly operationId: CommerceReadOperationId;
  readonly method: "GET";
  readonly path: string;
  readonly action: string;
  readonly scope: "AGENCY_HEADER" | "STORED_OPERATION";
  readonly summary: string;
  readonly authority: string;
}

/** The read spec the transport's admission reads (admitRead: path ids, the agency selector; a B09 read takes no query). */
export function readAdmissionSpecOf(spec: CommerceReadSpec): ReadSpec<string> {
  return Object.freeze({ operationId: spec.operationId, method: spec.method, path: spec.path, action: spec.action, scope: spec.scope === "AGENCY_HEADER" ? "AGENCY_HEADER" : "NONE", paginated: false, summary: spec.summary, authority: spec.authority });
}

/** The caller of a read: an agency member (TENANT, its resolved membership) or a corporate owner in the finance scope it adopted. */
export type ReadCaller = { readonly kind: "MEMBER"; readonly membership: ResolvedMembership } | { readonly kind: "OPERATOR"; readonly userId: UserId; readonly agencyId: AgencyId };

/**
 * Runs a read in B06's read discipline: an agency read under the member's TENANT context after `authorizeRead`, an operator's read
 * under its OPERATOR context after `authorizeOperator` adopted the stored operation's finance scope. A denial is a durable fact of
 * the read's action token; nothing else is written.
 */
export async function runCommerceRead<View>(
  runtime: CommerceRequestRuntime,
  spec: CommerceReadSpec,
  request: ReadRequest,
  body: (uow: CommerceUnitOfWork, caller: ReadCaller) => Promise<View>,
): Promise<ReadResult<View>> {
  const userId = request.subject.identity.userId as UserId;
  let context: TenantContext | OperatorContext;
  if (spec.scope === "AGENCY_HEADER") {
    if (request.agencyId === null) return { kind: "PROBLEM", problem: problemOf(new DomainFailure("INVALID_REQUEST", `${spec.operationId} needs an agency selector`, { reason: "TENANT_CONTEXT_MISSING" }), request.correlationId) };
    context = { kind: "TENANT", agencyId: request.agencyId, userId, correlationId: request.correlationId };
  } else {
    context = { kind: "OPERATOR", userId, correlationId: request.correlationId };
  }
  let accessDenied = false;
  let adopted: AgencyId | null = null;
  try {
    const view = await runtime.unitOfWork.run(context, async (uow) => {
      let caller: ReadCaller;
      if (context.kind === "TENANT") {
        const access = await runtime.authorizer.authorizeRead(uow, { identity: request.subject.identity, agencyId: context.agencyId });
        if (access.kind === "DENY") {
          accessDenied = true;
          throw CommerceAccessDenied.of(spec.operationId, access);
        }
        if (access.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency read was authorized without a membership");
        caller = { kind: "MEMBER", membership: access.membership };
      } else {
        const key = request.path["refundId"];
        if (key === undefined) throw new DomainFailure("INTEGRITY_FAILURE", `${spec.operationId} is keyed by its refund`);
        const access = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: request.subject.identity, role: "KAURO_OWNER", storedOperation: { kind: "REFUND", key } });
        if (access.kind === "DENY") {
          accessDenied = true;
          throw CommerceAccessDenied.of(spec.operationId, access);
        }
        adopted = uow.commerceScope;
        if (adopted === null) throw new DomainFailure("INTEGRITY_FAILURE", "an operator's read was authorized without its finance scope");
        caller = { kind: "OPERATOR", userId, agencyId: adopted };
      }
      return body(uow, caller);
    });
    return { kind: "READ", view };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (accessDenied || e.code === "NOT_AUTHORIZED" || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(runtime, context, spec.action, e, adopted);
    return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) as Problem };
  }
}


/**
 * The commission group's service routes (docs/design/B10-commercial-domain.md §7, §13; decisions D10-CTX-1, D10-STMT-4, D10-BIND-1;
 * mandate B10-STATEMENTS-PAYOUTS), registered on the api's server with their declared replies (the COMPLETED envelope and the Problem of
 * their closed catalogue), which the send guard enforces and tools/openapi.mjs documents under `paths`:
 *
 *  POST /api/v1/sales/commission-periods/{periodId}/close      CMD051 CloseCommissionPeriod (the commission service)
 *  POST /api/v1/sales/statements/{statementId}/reconcile-payout CMD053 ReconcileCommissionPayout (the finance service)
 *
 * The manual-10 admission of a command (content type, size, strict JSON, the closed request schema, Idempotency-Key, path ids), then the
 * verified service identity (the ServiceAuthenticator: issuer, audience, identity, environment). A person's token is not a service
 * identity: it is refused NOT_AUTHORIZED SERVICE_NOT_PERMITTED with the person's denial recorded; no subject at all is
 * AUTHENTICATION_REQUIRED with the anonymous denial recorded. Each command then runs in the commission service's own SERVICE units of work
 * (kauro_commission), journaled under the service's identity (migration 0034).
 *
 * The composition binds the platform's ports (D10-BIND-1): RecordedBankingCalendarSource (the latest VERIFIED_FEED version recorded; none
 * refuses the close CALENDAR_UNAVAILABLE) and UnavailablePayoutEvidenceVerifier (every reconciliation PAYOUT_EVIDENCE_UNAVAILABLE until
 * B15). Without the commission service's units of work (an edition that binds none) the routes are served all the same and find no
 * verified service identity.
 */
import type { BankingCalendarSource, CommandResult, CompletedResponse, CommandSpec, PayoutEvidenceVerifier, Problem, ProviderCallTimer, SchemaValidator, ServiceAuthenticator, StatementServiceHold, StatementServiceRuntime, UnauthenticatedRequest } from "@kauro/application";
import {
  CLOSE_COMMISSION_PERIOD,
  HEADERS,
  RECONCILE_COMMISSION_PAYOUT,
  UnavailablePayoutEvidenceVerifier,
  admitHeaders,
  realProviderCallTimer,
  admitStructure,
  closeCommissionPeriod,
  commercialCommandRouteResponses,
  createCommercialAuthorizer,
  problemOf,
  reconcileCommissionPayout,
  repeatedHeaderNames,
} from "@kauro/application";
import type { Clock, CorrelationId, Environment, ServiceIdentity } from "@kauro/domain";
import { DomainFailure, registryCommissionPolicy } from "@kauro/domain";
import { RecordedBankingCalendarSource, commissionWorkOf, ledgerOf, salesOf, statementsOf, type PgCommercialUnitOfWork, type PgCommercialUnitOfWorkFactory } from "@kauro/persistence";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Authenticator } from "../authenticator.js";
import { commercialPrincipalReader } from "../commercial-principals.js";
import type { RouteKit } from "../server.js";
import { serverNow } from "./ledger-effects.js";

/** What a deployment (or a test) binds for the commission group's service commands. */
export interface CommissionRoutesBinding {
  /** The commission service's units of work (its kauro_commission and kauro_control pools: openCommissionPools). */
  readonly units: PgCommercialUnitOfWorkFactory;
  /** The verified service identities; the payment service's authenticator when absent. */
  readonly serviceAuthenticator?: ServiceAuthenticator;
  /** BankingCalendarSource; RecordedBankingCalendarSource when absent (D10-BIND-1). */
  readonly calendar?: BankingCalendarSource;
  /** PayoutEvidenceVerifier; UnavailablePayoutEvidenceVerifier when absent (D10-BIND-1). */
  readonly payoutEvidence?: PayoutEvidenceVerifier;
  /** The provider-call bound's timer; realProviderCallTimer when absent (fault cells bind a clock-driven one). */
  readonly providerTimer?: ProviderCallTimer;
  /** Interleavings of the service commands (tests only). */
  readonly hold?: StatementServiceHold;
}

/** The runtime of the service commands over a binding: the commission service's units of work and the platform's ports. */
export function statementServiceRuntime(binding: CommissionRoutesBinding, environment: Environment, clock: Clock): StatementServiceRuntime {
  return {
    units: binding.units as unknown as StatementServiceRuntime["units"],
    environment,
    clock,
    authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }),
    policy: registryCommissionPolicy(),
    calendar: binding.calendar ?? new RecordedBankingCalendarSource(),
    payoutEvidence: binding.payoutEvidence ?? new UnavailablePayoutEvidenceVerifier(),
    providerTimer: binding.providerTimer ?? realProviderCallTimer,
    reads: { reportedAdjustments: (uow) => commissionWorkOf(uow).reportedAdjustments() },
    statements: statementsOf,
    ledger: ledgerOf,
    sales: salesOf,
    serverNow: (uow) => serverNow(uow as PgCommercialUnitOfWork),
    ...(binding.hold !== undefined ? { hold: binding.hold } : {}),
  };
}

export interface CommissionRouteDependencies {
  readonly binding: CommissionRoutesBinding | null;
  /** The service identities the routes verify (the binding's, else the payment service's), or null when none is bound. */
  readonly serviceAuthenticator: ServiceAuthenticator | null;
  /** The persons' authenticator: a person's token at a service route is a wrong service identity, recorded as the person's denial. */
  readonly persons: Authenticator;
  readonly environment: Environment;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  /** The runtime's refusal of an unauthenticated request: the anonymous DENY fact, then AUTHENTICATION_REQUIRED. */
  readonly refuseUnauthenticated: (action: string, request: UnauthenticatedRequest) => Promise<Problem>;
  /** Records a person's denial at a service route (the person's identity stream) and answers its problem. */
  readonly refusePerson: (action: string, userId: string, correlationId: CorrelationId, failure: DomainFailure) => Promise<Problem>;
}

/** `/api/v1/sales/statements/{statementId}/reconcile-payout` → `/api/v1/sales/statements/:statementId/reconcile-payout`. */
function fastifyPath(cataloguePath: string): string {
  return cataloguePath.replace(/\{([a-zA-Z]+)\}/g, ":$1");
}

type ServiceRequest<Body> = { readonly correlationId: CorrelationId; readonly idempotencyKey: string; readonly identity: ServiceIdentity; readonly path: Readonly<Record<string, string>>; readonly body: Body };

export function registerCommissionRoutes(app: FastifyInstance, kit: RouteKit, deps: CommissionRouteDependencies): void {
  const runtime = deps.binding === null ? null : statementServiceRuntime(deps.binding, deps.environment, deps.clock);
  registerServiceCommand(app, kit, deps, CLOSE_COMMISSION_PERIOD, runtime === null ? null : (request) => closeCommissionPeriod(runtime, request as never));
  registerServiceCommand(app, kit, deps, RECONCILE_COMMISSION_PAYOUT, runtime === null ? null : (request) => reconcileCommissionPayout(runtime, request as never));
}

function reply<View>(kit: RouteKit, r: FastifyReply, result: CommandResult<View>): FastifyReply {
  if (result.kind === "COMPLETED") {
    const body: CompletedResponse<View> = { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view };
    return r.code(result.status).type(HEADERS.contentType).send(body);
  }
  if (result.kind === "ACCEPTED") throw new DomainFailure("INTEGRITY_FAILURE", "a commission service command answers synchronously");
  return kit.sendProblem(r, result.problem);
}

function registerServiceCommand(
  app: FastifyInstance,
  kit: RouteKit,
  deps: CommissionRouteDependencies,
  spec: typeof CLOSE_COMMISSION_PERIOD | typeof RECONCILE_COMMISSION_PAYOUT,
  run: ((request: ServiceRequest<unknown>) => Promise<CommandResult<unknown>>) | null,
): void {
  // the manual-10 admission of a command over the command's closed request schema (no agency selector: the scope is the stored period or statement)
  const admissionSpec = {
    id: spec.id,
    name: spec.name,
    method: spec.method,
    path: spec.path,
    role: spec.role,
    scope: "NONE",
    aggregateParam: spec.aggregateParam,
    expectedVersionRequired: spec.expectedVersionRequired,
    stepUpRequired: false,
    authorityHashFields: spec.authorityHashFields,
    fields: spec.fields,
  } as unknown as CommandSpec<unknown>;
  app.route<{ Params: Record<string, string>; Body: Buffer | undefined }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    config: { responses: commercialCommandRouteResponses(spec.id) },
    onRequest: async (request, r) => {
      const early = admitHeaders({ headers: kit.singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
      if (early !== null) return kit.sendProblem(r, early.problem);
      return undefined;
    },
    handler: async (request, r) => {
      const headers = kit.singleValued(request.headers);
      const admission = admitStructure(admissionSpec, { headers, repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId, params: request.params, body: Buffer.isBuffer(request.body) ? request.body : null, clientAddressHash: null }, deps.validator, deps.clock);
      if (admission.kind === "PROBLEM") return kit.sendProblem(r, admission.problem);
      const correlationId = admission.admission.correlationId;
      try {
        const identity = run === null || deps.serviceAuthenticator === null ? null : await deps.serviceAuthenticator.authenticate(headers);
        if (identity === null || run === null) {
          // a person's token is not a service identity: the wrong principal, recorded in the person's stream
          const person = await deps.persons.authenticate(headers);
          if (person) {
            const failure = new DomainFailure("NOT_AUTHORIZED", `${spec.id} denied: SERVICE_NOT_PERMITTED`, { reason: "SERVICE_NOT_PERMITTED" });
            return kit.sendProblem(r, await deps.refusePerson(spec.id, person.identity.userId, correlationId, failure));
          }
          return kit.sendProblem(r, await deps.refuseUnauthenticated(spec.id, { correlationId, agencyId: null }));
        }
        const result = await run({ correlationId, idempotencyKey: admission.admission.idempotencyKey, identity, path: admission.admission.path, body: admission.admission.body });
        return reply(kit, r, result);
      } catch (error) {
        if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return kit.sendProblem(r, problemOf(error, correlationId));
        kit.sink(correlationId, error);
        return kit.sendProblem(r, problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId));
      }
    },
  });
}

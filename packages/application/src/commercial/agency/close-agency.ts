/**
 * CMD043 CloseAgency — POST /api/v1/agencies/{agencyId}/closure-requests — AGENCY_OWNER with a fresh step-up — scope AGENCY_PATH — no
 * provider effect (design §4, §8.1, §10, §12; decisions D10-AGY-2, D10-AGY-4, D10-AGY-6; registry "stop new work, settle/reconcile
 * existing obligations and schedule managed-scope deletion/closure"; "closure cannot erase payable seller rights, fiscal obligations or
 * customer refund rights").
 *
 * One unit of work of the owner's own TENANT context, in B06's pipeline order: access (B06 authorizer: the agency's ACTIVE OWNER) →
 * journal reserve (or the replay of the journaled 200 — a replay performs no effect and needs no new proof) → the body, the first
 * failure answering: the owner's step-up fresh (ASSURANCE_REQUIRED; its ALLOW fact commits with the closure) → the agency FOR UPDATE →
 * expectedVersion (STALE_VERSION) → the agency DRAFT, ACTIVE or RESTRICTED (the edges owner_abandons_setup and owner_requests_closure; any
 * other state is UNLISTED_TRANSITION) → the obligations inventory, read after the agency's exclusive transition half — B09's checkout and
 * capture hold its shared half, so a closure racing them serializes with them in both orders — with the work B06's ActiveWorkInspector
 * reports for each client of the agency; a payment order or refund in flight or uncertain refuses the request
 * (CLOSURE_OBLIGATIONS_UNRECONCILED); an OPEN reconciliation case does not (D10-AGY-4): it is inventoried with its kind, amount and age and
 * refuses the CLOSED edge instead (KC006). Writes: every open quote WITHDRAWN (quote.withdrawn.v1) with its founding reservation
 * RELEASED and its slot freed, the closure record with the inventory and the managed-deletion schedule (the interval is exact hours after
 * the server's request instant), and the agency CLOSING at version + 1 (agency.closing.v1). New work stops because B06 and B09 require the
 * agency DRAFT or ACTIVE; no commission, fiscal or ledger row is deleted or touched, so a closing agency's lines keep their path to payment.
 * The CLOSED edge's performer is B16 (verified managed deletion; D10-AGY-2).
 */
import type { UtcInstant } from "@kauro/contracts";
import { toUtcInstant } from "@kauro/domain";
import type { AgencyClosureId, AgencyId, AssuranceProofId, CausationId, ClientId, ClosureCaseEntry, ClosureFromState, EndClientRecord, QuoteId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, abandonSetup, requestClosure } from "@kauro/domain";
import type { MoneyMinorUnits } from "@kauro/contracts";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { agencyView } from "../../api/projections.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, runCommerceCommand, tenantContextOf, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { CLOSE_AGENCY, type CloseAgencyBody } from "../contracts.js";
import type { AgencyClosureView } from "../views.js";
import { commercialAdmissionSpecOf, type AgencyLifecycleCollaborators, type CommercialCommandHandler } from "./runtime.js";
import { applied, checkExpectedVersion, requireMembershipOf } from "./shared.js";

/** The managed deletion of a closed agency's data is scheduled 720 hours (thirty days) after the request (D10-AGY-6). */
export const CLOSURE_DELETION_DELAY_HOURS = 720;
const HOUR_MS = 3_600_000;
const CLIENT_PAGE = 100;

/** The agencies a closure may request from: DRAFT (owner_abandons_setup), ACTIVE and RESTRICTED (owner_requests_closure). */
const CLOSABLE: ReadonlySet<string> = new Set(["DRAFT", "ACTIVE", "RESTRICTED"]);

export function closeAgencyHandler(runtime: CommerceRequestRuntime, co: AgencyLifecycleCollaborators): CommercialCommandHandler<CloseAgencyBody, AgencyClosureView> {
  const spec = CLOSE_AGENCY;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<CloseAgencyBody>): Promise<CommandResult<AgencyClosureView>> {
      const context = tenantContextOf(envelope);
      const agencyId = context.agencyId;
      let membership: ReturnType<typeof requireMembershipOf> | null = null;
      return runCommerceCommand<CloseAgencyBody, AgencyClosureView>(runtime, {
        command: { id: spec.id, journalScope: "TENANT" },
        envelope,
        context,
        async access(uow) {
          const decision = await runtime.authorizer.authorize(uow, { command: "CMD043", identity: envelope.subject.identity, agencyId });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD043", decision);
          membership = requireMembershipOf(decision.membership);
        },
        async body(uow, causationId: CausationId, now: UtcInstant) {
          if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a closure was authorized without a membership");
          const body = envelope.body;
          // the owner's fresh step-up (a new execution only; the proof is the owner's own and recorded by the step-up verifier)
          const assured = await co.assurance.verifyStepUp(uow, envelope.userId, body.assuranceProofRef as AssuranceProofId, now);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `closing an agency needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const life = co.lifecycle(uow);
          // the agency's exclusive half, then its row (D10-TX-1); the row first would deadlock with a payment order's continuation, which
          // holds the shared half while its inserts wait for the row's KEY SHARE (40P01)
          await life.lockTransition(agencyId);
          const agency = await uow.agencies.lock(agencyId);
          if (agency === null) throw new NotFoundFailure("agency");
          checkExpectedVersion(agency, body.expectedVersion);
          if (!CLOSABLE.has(agency.state)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the agency is closing or closed: closure is requested from DRAFT, ACTIVE or RESTRICTED", { reason: "UNLISTED_TRANSITION", currentVersion: agency.version, currentState: agency.state });
          }
          // the work the agency still retains, by client (B06's inspector reports per client): open projects and active jobs
          let activeWork = 0;
          let after: { readonly createdAt: UtcInstant; readonly clientId: ClientId } | undefined;
          for (;;) {
            const page: ReadonlyArray<EndClientRecord> = await uow.endClients.list(agencyId, { ...(after !== undefined ? { after } : {}), limit: CLIENT_PAGE });
            for (const client of page) {
              const work = await co.activeWork.inspectClient(uow, client.clientId);
              activeWork += work.openProjects + work.activeJobs;
            }
            if (page.length < CLIENT_PAGE) break;
            const last = page[page.length - 1] as EndClientRecord;
            after = { createdAt: last.createdAt, clientId: last.clientId };
          }
          // the inventory after the agency's exclusive half: nothing of the agency commits beside this read
          const obligations = await life.closureObligations(agencyId, activeWork);
          if (obligations.inFlight.paymentOrderIds.length > 0 || obligations.inFlight.refundIds.length > 0) {
            throw new DomainFailure("PRECONDITION_FAILED", "a payment order or refund of the agency is in flight or uncertain", { reason: "CLOSURE_OBLIGATIONS_UNRECONCILED", currentVersion: agency.version, currentState: agency.state });
          }
          // new work stops: every open quote is withdrawn, its founding reservation released and its slot freed
          const withdrawn: QuoteId[] = [];
          for (const quoteId of obligations.openQuoteIds) {
            const quote = await uow.commerce.quotes.lock(quoteId);
            if (quote === null) throw new DomainFailure("INTEGRITY_FAILURE", "an open quote of the agency is not visible to its owner");
            applied(await uow.commerce.quotes.transition(quoteId, quote.version, { state: "WITHDRAWN" }, now));
            await life.releaseFoundingReservation(quoteId);
            withdrawn.push(quoteId);
          }
          const edge = agency.state === "DRAFT" ? abandonSetup(agency, { expectedVersion: body.expectedVersion, now }) : requestClosure(agency, { expectedVersion: body.expectedVersion, now });
          const deletionScheduledAt = toUtcInstant(Date.parse(now) + CLOSURE_DELETION_DELAY_HOURS * HOUR_MS);
          const closure = await life.recordClosure({
            closureId: uow.ids.next() as AgencyClosureId,
            agencyId: agencyId as AgencyId,
            membershipId: membership.membershipId,
            assuranceProofId: body.assuranceProofRef as AssuranceProofId,
            fromState: agency.state as ClosureFromState,
            obligations,
            withdrawnQuoteIds: withdrawn,
            deletionScheduledAt,
            requestedAt: now,
          });
          const next = applied(await uow.agencies.transition(agencyId, agency.version, { state: edge.agency.state }, now));
          await uow.events.publish({
            aggregateKind: "agency",
            aggregateId: agencyId,
            aggregateVersion: next.version,
            agencyId,
            eventType: "agency.closing.v1",
            actor: { kind: "USER", userId: envelope.userId },
            causationId,
            correlationId: envelope.correlationId,
            payload: edge.event.payload,
          });
          const cents = obligations.openCases.reduce((sum: bigint, c: ClosureCaseEntry) => sum + (c.amountCents ?? 0n), 0n);
          return {
            status: 200,
            view: {
              agency: agencyView(next, membership.role),
              closureId: closure.closureId,
              requestedAt: closure.requestedAt,
              obligations: {
                openQuotesWithdrawn: withdrawn.length,
                liveAuthorizations: obligations.liveAuthorizationIds.length,
                openRefunds: obligations.openRefundIds.length,
                nonTerminalTaxDocuments: obligations.nonTerminalTaxDocumentIds.length,
                openReconciliationCases: obligations.openCases.length,
                activeWorkItems: obligations.activeWork,
                openReconciliationCents: cents.toString() as MoneyMinorUnits,
              },
              deletionScheduledFor: closure.deletionScheduledAt,
            },
            version: next.version,
            resourceKind: "agency",
            resourceId: agencyId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}

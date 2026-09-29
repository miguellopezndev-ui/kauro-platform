/**
 * CMD031 RequestRefund — POST /api/v1/projects/{projectId}/refund-requests — AGENCY_BILLING — scope AGENCY_HEADER — no provider
 * effect (design §8 CMD031; D-REF-B1, D-LABEL-B1; implementation mandate M4).
 *
 * "Customer cancellation is not direct permission to send arbitrary PSP refunds" (CMD031 failure): a request is REQUESTED and
 * nothing more — the agency's role holds no update on refunds, the approval needs a corporate owner other than the requester
 * (KP007, KP008), and no provider is ever called here.
 *
 * One unit of work in B06's pipeline order: access (B06 authorizer: AGENCY_BILLING) → journal → the project visible (NOT_FOUND) →
 * its latest COMPLETED capture, read after the capture's shared half, with a refundable service or tax balance given every committed
 * refund (NOTHING_TO_REFUND) → no REQUESTED customer refund of that capture (REFUND_REQUEST_OPEN; a pending server request of
 * another origin does not block it, D-REF-B1; the database's refunds_one_requested_per_origin decides a race). Writes: the refund
 * REQUESTED with the proposal (the whole remaining service and the tax it releases, proposeRefund), the delivery phase of the
 * capture's entitlement (deliveryPhaseOf), the order's terms hash, the reason verbatim (a label: stored and answered, never in an
 * event), the evidence reference (stored opaquely, Q-B09-10) and the requester; refund.requested.v1; the REFUND scope row. 201.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId, CommercialAuthorizationRecord, EvidenceRef, MembershipId, ProjectId, RefundId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, deliveryPhaseOf, proposeRefund, refundableBalance } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { REQUEST_REFUND, type RequestRefundBody } from "../contracts.js";
import type { RequestRefundView } from "../views.js";
import { refundView } from "./projections.js";
import { CommerceAccessDenied, admissionSpecOf, runCommerceCommand, tenantContextOf, type CommerceRequestCollaborators, type CommerceRequestRuntime } from "./runtime.js";
import type { CommerceCommandHandler } from "./unbound.js";

const nothingToRefund = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the project has no completed capture with a refundable service or tax balance", { reason: "NOTHING_TO_REFUND" });

export function requestRefundHandler(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators): CommerceCommandHandler<RequestRefundBody, RequestRefundView> {
  const spec = REQUEST_REFUND;
  return {
    spec,
    admission: admissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RequestRefundBody>): Promise<CommandResult<RequestRefundView>> {
      const context = tenantContextOf(envelope);
      const agencyId = context.agencyId;
      let membershipId: MembershipId | null = null;
      return runCommerceCommand<RequestRefundBody, RequestRefundView>(runtime, {
        command: spec,
        envelope,
        context,
        async access(uow) {
          const decision = await runtime.authorizer.authorize(uow, { command: "CMD031", identity: envelope.subject.identity, agencyId });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD031", decision);
          membershipId = decision.membership?.membershipId ?? null;
        },
        async body(uow, _causationId: CausationId, now: UtcInstant) {
          const c = uow.commerce;
          if (membershipId === null) throw new DomainFailure("INTEGRITY_FAILURE", "a refund request was authorized without a membership");
          const projectId = envelope.path["projectId"] as ProjectId;
          const project = await uow.projects.get(projectId);
          if (project === null || project.agencyId !== agencyId) throw new NotFoundFailure("project");
          const captureId = await co.queries.latestCompletedCaptureOfProject(uow, projectId);
          if (captureId === null) throw nothingToRefund();
          // the capture after its shared half: a reversal in flight is ordered before this request or after it (design §6.2)
          await co.queries.awaitTransition(uow, "kauro.capture_facts", captureId);
          const capture = await c.captures.get(captureId);
          if (capture === null) throw new DomainFailure("INTEGRITY_FAILURE", "a completed capture of a visible project is not visible");
          const balance = refundableBalance(capture, await c.captures.committedRefunds(captureId));
          if (balance.serviceCents + balance.taxCents === 0n) throw nothingToRefund();
          if ((await c.refunds.findOpenForCapture(captureId, "CUSTOMER_REQUEST")) !== null) {
            throw new DomainFailure("PRECONDITION_FAILED", "a request of this capture already awaits review", { reason: "REFUND_REQUEST_OPEN" });
          }
          const order = await c.orders.get(capture.orderId);
          if (order === null) throw new DomainFailure("INTEGRITY_FAILURE", "the order of a visible capture is not visible");
          // the processing/delivery state recorded with the request: the capture's live entitlement, else the one it last carried
          let authorization: CommercialAuthorizationRecord | null = await c.authorizations.findLiveByCapture(captureId);
          if (authorization === null) {
            const ofQuote = await c.authorizations.findByQuote(order.quoteId);
            authorization = ofQuote !== null && ofQuote.captureId === captureId ? ofQuote : null;
          }
          const refundId = uow.ids.next() as RefundId;
          const refund = await c.refunds.request({
            refundId,
            agencyId,
            projectId,
            orderId: order.orderId,
            captureId,
            origin: "CUSTOMER_REQUEST",
            reasonCode: envelope.body.reasonCode,
            evidenceRef: envelope.body.evidenceRef as EvidenceRef,
            termsHash: order.termsHash,
            deliveryPhase: deliveryPhaseOf(authorization),
            proposed: proposeRefund("CUSTOMER_REQUEST", balance),
            requestedByMembershipId: membershipId,
            requestedByUserId: envelope.userId,
            requestedAt: now,
          });
          await uow.scopes.record({ kind: "REFUND", key: refundId, agencyId, orderId: order.orderId, refundId }, now);
          return { status: 201, view: { refund: refundView(refund) }, version: refund.version, resourceKind: "refund", resourceId: refundId };
        },
      });
    },
  };
}

/**
 * CMD032 ApproveRefund — POST /api/v1/refunds/{refundId}/approve — KAURO_OWNER — scope STORED_OPERATION — no provider effect (design
 * §8 CMD032; D-AUTHZ-B1..B3, D-CORP-B1, D-IDEM-B2, D-REF-B2..B6, D-FACT-B1; implementation mandate M4).
 *
 * "The total cannot exceed reconciled remaining capture; a standing authorized policy must be referenced rather than invented"
 * (CMD032 failure). A corporate owner (an individually managed corporate identity with an ACTIVE KAURO_OWNER grant; 08) records the
 * immutable intent of a refund; the payment service executes it later (CMD033, M3).
 *
 * One unit of work of the OPERATOR context (kauro_app, its user bound): access — authorizeOperator: the identity ACTIVE and verified,
 * the operator's own ACTIVE grant after its transition lock (CORPORATE_ROLE_MISSING), the refund resolved and adopted through the
 * scope index as the operator's finance scope (NOT_FOUND alike for foreign and unknown, D-CORE-B5) → journal, the operator's own
 * identity-owned entry (agency NULL, D-IDEM-B2) → read the refund, the capture's shared half and its live entitlement's, lock the
 * refund → assureOperator: a standing policy that covers the refund as it stands (policyCovers, D-REF-B4; one that does not is
 * POLICY_NOT_APPLICABLE), else a fresh step-up proof of the operator (08 "significant refund") → preconditions: expectedVersion
 * (STALE_VERSION), REQUESTED (REFUND_NOT_REQUESTED), capture COMPLETED (CAPTURE_NOT_REFUNDABLE), the components valid for the origin
 * and within the remaining capture (REFUND_COMPONENT_INVALID, REFUND_EXCEEDS_REMAINING; an excess return approves the recorded excess
 * with zero service and tax, D-REF-B2), the tax exactly what the service releases under the sale's reviewed rule given every
 * committed refund (REFUND_TAX_INCONSISTENT, D-REF-B6), the approver not the requester (SELF_APPROVAL_FORBIDDEN, D-AUTHZ-B2). The
 * database repeats every one it can see (KP003, KP007, KP008, KP010, KP012; READ COMMITTED only, KP009). Writes: the immutable intent
 * — amounts, authority, KAURO_REFUND_AUTHORIZATION_V1 over the amounts, the approved reason (a label: a digest may cover it, a
 * payload never carries it), the authority, approver and instant, and KAURO_REFUND_EFFECTS_V1 over the credit-note requirement, the
 * remaining service basis (R2-081) and whether it revokes the entitlement — refund.approved.v1 to PAYMENT_SERVICE, and the ALLOW fact
 * of the authorization in the operator's identity stream naming the agency (D-REQ-B5). 200.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommercialAuthorizationRecord, RefundApprovalRecord, RefundComponents, RefundEffects, RefundId, UserId } from "@kauro/domain";
import {
  COMMERCE_POLICY_VERSION,
  DomainFailure,
  NotAuthorizedFailure,
  NotFoundFailure,
  StaleVersionFailure,
  approvedComponents,
  authorizationPreimageMoney,
  checkRefundAmounts,
  checkRefundTax,
  deliveryPhaseOf,
  formatMoney,
  parseMoney,
  policyCovers,
  refundAmountFailure,
  refundAuthorizationHash,
  refundEffectsHash,
  refundTaxFailure,
  refundableBalance,
} from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { APPROVE_REFUND, type ApproveRefundBody } from "../contracts.js";
import type { ApproveRefundView } from "../views.js";
import { refundEffectsView, refundView } from "./projections.js";
import { CommerceAccessDenied, admissionSpecOf, operatorContextOf, runCommerceCommand, type CommerceRequestCollaborators, type CommerceRequestRuntime } from "./runtime.js";
import type { CommerceCommandHandler } from "./unbound.js";
import { approveCaptureWithDestination, namesDestination } from "../bank/approve-destination.js";

/**
 * A money member of the body in minor units: the closed schema admits a MoneyMinorUnits string of up to sixteen digits, and an amount
 * beyond the platform's exact envelope (2^53 - 1, D-MONEY-B1) is refused as the schema violation it is.
 */
export function moneyField(field: "serviceCents" | "taxCents", value: string): bigint {
  try {
    return parseMoney(field, value);
  } catch (e) {
    if (e instanceof DomainFailure && e.code === "INVALID_REQUEST") throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code: "RANGE" }] });
    throw e;
  }
}

/** The reason token of the ALLOW fact of an approval authorized by a standing refund policy (D-REQ-B5). */
export const STANDING_POLICY_APPLIED = "STANDING_POLICY_APPLIED";

/** The prepared effects of approving `requested` of a capture whose committing refunds hold `committed` (CMD032; R2-081, D-REF-B5). */
export function refundEffectsOf(
  refund: { readonly refundId: string; readonly captureId: string; readonly termsHash: RefundEffects["termsHash"] },
  allocation: RefundComponents,
  committed: RefundComponents,
  requested: RefundComponents,
  phase: RefundEffects["deliveryPhase"],
  liveAuthorization: boolean,
): { readonly effects: RefundEffects; readonly remaining: RefundComponents } {
  // never below zero: a review can show a proposal that another committed refund has since overtaken (its approval is then refused)
  const left = (a: bigint, b: bigint, c: bigint): bigint => (a - b - c > 0n ? a - b - c : 0n);
  const basisAfter = left(allocation.serviceCents, committed.serviceCents, requested.serviceCents);
  const remaining: RefundComponents = {
    serviceCents: basisAfter,
    taxCents: left(allocation.taxCents, committed.taxCents, requested.taxCents),
    excessCents: left(allocation.excessCents, committed.excessCents, requested.excessCents),
  };
  return {
    effects: {
      refundId: refund.refundId,
      captureId: refund.captureId,
      termsHash: refund.termsHash,
      deliveryPhase: phase,
      creditNoteRequired: requested.serviceCents > 0n || requested.taxCents > 0n,
      serviceBasisAfterCents: formatMoney(basisAfter),
      revokesAuthorization: liveAuthorization && allocation.serviceCents > 0n && basisAfter === 0n,
    },
    remaining,
  };
}

export function approveRefundHandler(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators): CommerceCommandHandler<ApproveRefundBody, ApproveRefundView> {
  const spec = APPROVE_REFUND;
  return {
    spec,
    admission: admissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<ApproveRefundBody>): Promise<CommandResult<ApproveRefundView>> {
      const context = operatorContextOf(envelope);
      const userId = envelope.userId as UserId;
      const refundId = envelope.path["refundId"] as RefundId;
      // Payments V1 F2 (lane L-REFUND): a body naming the manual rail's destination is the owner's bank approval, run by the payment service
      if (namesDestination(envelope.body)) return approveCaptureWithDestination({ runtime, payment: co.payment, paymentServiceId: co.paymentServiceId, bank: co.bank ?? null }, co, envelope);
      return runCommerceCommand<ApproveRefundBody, ApproveRefundView>(runtime, {
        command: spec,
        envelope,
        context,
        async access(uow) {
          const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: envelope.subject.identity, role: "KAURO_OWNER", storedOperation: { kind: "REFUND", key: refundId } });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD032", decision);
        },
        async body(uow, _causationId, now: UtcInstant) {
          const c = uow.commerce;
          const body = envelope.body;
          const seen = await c.refunds.get(refundId);
          if (seen === null) throw new NotFoundFailure("refund");
          // a capture paid by bank transfer is refunded on the manual rail only, with its destination captured (Payments V1 F2, DV1-10)
          if (co.bank != null && (await co.bank.routes(uow).instructionsOf(seen.orderId)) !== null) {
            throw new DomainFailure("INTEGRITY_FAILURE", "a capture paid by bank transfer is refunded only with its destination captured", { reason: "DESTINATION_NOT_CAPTURED" });
          }
          // the shared halves of what the approval relies on (the capture, its live entitlement), then the refund's row lock
          await co.queries.awaitTransition(uow, "kauro.capture_facts", seen.captureId);
          const live: CommercialAuthorizationRecord | null = await c.authorizations.findLiveByCapture(seen.captureId);
          if (live !== null) await co.queries.awaitTransition(uow, "kauro.commercial_authorizations", live.authorizationId);
          // the finance scope may lock a refund only while it is REQUESTED (refunds_finance_review): a refund already reviewed, or one a
          // concurrent approval moved on while this one waited for its row, is answered from its committed row (STALE_VERSION or
          // REFUND_NOT_REQUESTED below, with its current version and state)
          const refund = (await c.refunds.lock(refundId)) ?? (await c.refunds.get(refundId));
          if (refund === null) throw new NotFoundFailure("refund");
          const capture = await c.captures.get(refund.captureId);
          const order = await c.orders.get(refund.orderId);
          const quote = order === null ? null : await c.quotes.get(order.quoteId);
          if (capture === null || order === null || quote === null) throw new DomainFailure("INTEGRITY_FAILURE", "the capture, order and quote of a visible refund are visible to its finance scope");
          const committed = await c.captures.committedRefunds(capture.captureId);
          const balance = refundableBalance(capture, committed);
          const phase = deliveryPhaseOf(live ?? (await c.authorizations.findByQuote(order.quoteId)));
          const requested = approvedComponents(refund.origin, refund.proposed, { serviceCents: moneyField("serviceCents", body.serviceCents), taxCents: moneyField("taxCents", body.taxCents) });

          // assurance of a new execution: a standing policy that covers exactly this refund, else the operator's own fresh step-up
          const assurance = await runtime.commerceAuthorizer.assureOperator(uow, {
            userId,
            authorizationRef: body.authorizationRef,
            covers: async (policyId) => {
              const policy = await c.refundPolicies.get(policyId);
              return policy !== null && policyCovers(policy, { at: now, origin: refund.origin, phase, balance, requested });
            },
          });
          if (assurance.kind === "DENY") throw CommerceAccessDenied.of("CMD032", assurance);

          // preconditions, in the design's order (§8 CMD032)
          if (refund.version !== body.expectedVersion) throw new StaleVersionFailure(refund.version, refund.state);
          if (refund.state !== "REQUESTED") throw new DomainFailure("PRECONDITION_FAILED", "the refund is not REQUESTED", { reason: "REFUND_NOT_REQUESTED", currentVersion: refund.version, currentState: refund.state });
          if (capture.status !== "COMPLETED") throw new DomainFailure("PRECONDITION_FAILED", "the capture is not refundable", { reason: "CAPTURE_NOT_REFUNDABLE" });
          const amounts = checkRefundAmounts(refund.origin, balance, requested);
          if (amounts.kind !== "OK") throw refundAmountFailure(amounts);
          if (checkRefundTax(capture.allocation, committed, requested, quote.tax).kind !== "OK") throw refundTaxFailure();
          if (refund.requestedByUserId !== undefined && refund.requestedByUserId === userId) throw new NotAuthorizedFailure("SELF_APPROVAL_FORBIDDEN", "the approver requested this refund");

          // the immutable intent
          const { effects, remaining } = refundEffectsOf(refund, capture.allocation, committed, requested, phase, live !== null);
          const effectsHash = refundEffectsHash(effects);
          const byPolicy = assurance.assuranceClass === "STANDING_POLICY";
          const authorizationRef = byPolicy ? assurance.policyId : assurance.proofRef;
          const authorizationHash = refundAuthorizationHash({
            refundId: refund.refundId,
            agencyId: refund.agencyId,
            captureId: refund.captureId,
            ...authorizationPreimageMoney(requested),
            reasonCode: refund.reasonCode,
            authorizationKind: byPolicy ? "STANDING_POLICY" : "OWNER_STEP_UP",
            authorizationRef,
            approvedByUserId: userId,
            approvedAt: now,
            effectsHash,
          });
          const approval: RefundApprovalRecord = {
            amounts: requested,
            authorizationKind: byPolicy ? "STANDING_POLICY" : "OWNER_STEP_UP",
            ...(byPolicy ? { authorizationPolicyId: assurance.policyId } : { authorizationProofRef: assurance.proofRef }),
            authorizationHash,
            effectsHash,
            creditNoteRequired: effects.creditNoteRequired,
            approvedByUserId: userId,
            approvedAt: now,
          };
          const written = await c.refunds.approve(refundId, refund.version, approval, now);
          if (written.kind === "STALE") throw new StaleVersionFailure(written.currentVersion, written.currentState);
          const view: ApproveRefundView = { refund: refundView(written.record), effects: refundEffectsView(effects, remaining, effectsHash), authorizationKind: approval.authorizationKind };
          return {
            status: 200,
            view,
            version: written.record.version,
            resourceKind: "refund",
            resourceId: refundId,
            allowFact: byPolicy
              ? { reasonCode: STANDING_POLICY_APPLIED, assuranceClass: "SESSION", policyVersion: COMMERCE_POLICY_VERSION }
              : { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: COMMERCE_POLICY_VERSION },
          };
        },
      });
    },
  };
}

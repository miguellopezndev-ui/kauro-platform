/**
 * PurchaseRebinder (docs/design/B09-payments-fiscal.md §4.3, D-QUOTE-B6; B09-F2; stage-2 mandate M3): the included pre-execution
 * source replacement (16 "Scope changes and credits": "one pre-execution source replacement after revalidation, provided no paid
 * execution has started and the new scope stays in the same band"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18 "Record the replacement
 * against the purchased entitlement; do not charge a new project by default"). Called by the recurrence package's replacement
 * flow (B10, R2-092) once the new revision is sealed, its plan approved and the replacement quote issued, in a SERVICE unit of work
 * under kauro_payment (only the payment service revokes and issues entitlements, B09-F1). The caller's unit of work has adopted the
 * paid order's scope (adoptScope("PAYMENT_ORDER", the capture's order); D-SCOPE-B1, decision D-M3-B6): the payment service sees
 * nothing of an agency before it adopts one of its stored operations, and the re-binding's input names the capture, not the order —
 * a unit of work that adopted nothing is refused INTEGRITY_FAILURE before anything is read, and a capture its adopted agency does not
 * hold is NOT_FOUND.
 *
 * The domain decides first (commerce/authority replacementBlockers: the replaced entitlement ACTIVE — no execution started —, the
 * capture alone pays its purchase and no refund of it is open or committed, the replacement an ISSUED replacement of the accepted
 * quote, the policy's allowance not used, and the source lifecycle's lineage from the replaced revision to the SEALED replacement,
 * SourceLineageReader of B07 — without a bound reader the lineage is missing); the database re-checks all of it (KP013,
 * purchase_rebindings_guard, under the replaced entitlement's exclusive lock, the capture's shared lock and its refund commitment
 * lock). Then, in the one transaction: the re-binding recorded, the replaced entitlement REVOKED as SOURCE_REPLACED
 * (PRE_EXECUTION), the replaced quote SUPERSEDED by the replacement, the replacement ACCEPTED_FOR_CHECKOUT and its entitlement
 * issued under the re-binding on the same capture — each version with the event commerceVersionEventType names.
 */
import type { PurchaseRebinder, SourceLineageReader } from "@kauro/application";
import { publishVersionEvent, versionEvent } from "@kauro/application";
import type { CommercialAuthorizationId, CommercialAuthorizationRecord, PurchaseRebindingId, QuoteRecord, ReplacementBlocker } from "@kauro/domain";
import { COMMITTING_REFUND_STATES, DomainFailure, NotFoundFailure, authorizesObligation, replacementBlockers } from "@kauro/domain";
import { pgPurchasedSubjectReader } from "./runtime.js";

function applied<T>(write: { readonly kind: "APPLIED"; readonly record: T } | { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }, what: string): T {
  if (write.kind === "STALE") throw new DomainFailure("STALE_VERSION", `${what} changed concurrently: current is ${write.currentVersion} (${write.currentState})`, { currentVersion: write.currentVersion, currentState: write.currentState }, true);
  return write.record;
}

export function createPurchaseRebinder(deps: { readonly lineage?: SourceLineageReader }): PurchaseRebinder {
  return {
    async rebind(uow, input) {
      if (uow.context.kind !== "SERVICE") throw new DomainFailure("INTEGRITY_FAILURE", "a re-binding runs in a SERVICE unit of work of the payment service (D-QUOTE-B6)");
      if (uow.commerceScope === null) throw new DomainFailure("INTEGRITY_FAILURE", "a re-binding runs in a unit of work that adopted the paid order's scope (D-SCOPE-B1, D-M3-B6)");
      const c = uow.commerce;
      const capture = await c.captures.get(input.captureId);
      if (capture === null || capture.agencyId !== uow.commerceScope) throw new NotFoundFailure("capture");
      const order = await c.orders.get(capture.orderId);
      const from = await c.quotes.get(input.fromQuoteId);
      const to = await c.quotes.get(input.toQuoteId);
      if (order === null || from === null || to === null) throw new NotFoundFailure("quote");
      const replaced = await c.authorizations.findLiveByCapture(capture.captureId);
      const refunds = await c.refunds.listForCapture(capture.captureId);
      const policy = await c.pricePolicies.get(from.pricePolicyVersion);
      const lineage = deps.lineage === undefined ? null : await deps.lineage.replacementOf(uow, { agencyId: from.agencyId, projectId: from.projectId, replacedRevisionHash: from.revisionHash, replacementRevisionHash: to.revisionHash });
      const used = (await c.rebindings.listForCapture(capture.captureId)).length;
      const blockers: ReplacementBlocker[] = [
        ...replacementBlockers({
          authorizationState: replaced?.state ?? "REVOKED",
          captureAlonePays: authorizesObligation(order, capture),
          refundOpenOrCommitted: refunds.some((r) => r.state === "REQUESTED" || COMMITTING_REFUND_STATES.has(r.state)),
          replacedQuoteState: from.state,
          replacement: { state: to.state, replacesTheQuote: to.replacesQuoteId === from.quoteId },
          replacementsUsed: used,
          replacementsIncluded: policy?.preExecutionReplacementsIncluded ?? 0,
          lineageReachesReplaced: lineage !== null && lineage.replacementSealed,
        }),
      ];
      if (replaced === null || replaced.quoteId !== from.quoteId) blockers.push("PURCHASE_NOT_INTACT");
      const subject = await pgPurchasedSubjectReader.subjectOf(uow, to);
      if (subject === null || subject.approval === null || subject.capability === null) blockers.push("NOT_A_REPLACEMENT");
      if (blockers.length > 0 || replaced === null || lineage === null || subject === null || subject.approval === null || subject.capability === null) {
        return { kind: "REFUSED", blockers: [...new Set(blockers)] };
      }
      const now = input.now;
      const rebindingId = uow.ids.next() as PurchaseRebindingId;
      const authorizationId = uow.ids.next() as CommercialAuthorizationId;
      await c.rebindings.record({
        rebindingId,
        agencyId: from.agencyId,
        projectId: from.projectId,
        orderId: order.orderId,
        captureId: capture.captureId,
        fromQuoteId: from.quoteId,
        fromAuthorizationId: replaced.authorizationId,
        toQuoteId: to.quoteId,
        allowanceOrdinal: used + 1,
        reasonCode: "PRE_EXECUTION_SOURCE_REPLACEMENT",
        lineageEvidenceHash: lineage.evidenceHash,
        requestedByMembershipId: input.requestedByMembershipId,
        createdAt: now,
      });
      await revoke(uow, replaced, input.causationId, now);
      const superseded = applied(await c.quotes.transition(from.quoteId, from.version, { state: "SUPERSEDED", supersededByQuoteId: to.quoteId }, now), "the replaced quote");
      await publishVersionEvent(uow, versionEvent("quote", from.quoteId, superseded.version, from.agencyId, { previousState: from.state, state: "SUPERSEDED" }, { quoteId: from.quoteId, agencyId: from.agencyId, successorQuoteId: to.quoteId, previousState: from.state }), input.causationId);
      const accepted = applied(await c.quotes.transition(to.quoteId, to.version, { state: "ACCEPTED_FOR_CHECKOUT" }, now), "the replacement quote");
      await publishVersionEvent(uow, versionEvent("quote", to.quoteId, accepted.version, to.agencyId, { previousState: to.state, state: "ACCEPTED_FOR_CHECKOUT" }, { quoteId: to.quoteId, agencyId: to.agencyId, termsHash: to.termsHash, orderId: order.orderId, previousState: to.state }), input.causationId);
      await issueReplacement(uow, { to, order, capture, rebindingId, authorizationId, subject: { approvalHash: subject.approval.approvalHash, capabilityId: subject.capability.capabilityId, capabilityVersion: subject.capability.capabilityVersion }, now, causationId: input.causationId });
      return { kind: "REBOUND", rebindingId, authorizationId };
    },
  };
}

async function revoke(uow: Parameters<PurchaseRebinder["rebind"]>[0], a: CommercialAuthorizationRecord, causationId: Parameters<PurchaseRebinder["rebind"]>[1]["causationId"], now: Parameters<PurchaseRebinder["rebind"]>[1]["now"]): Promise<void> {
  const revoked = applied(await uow.commerce.authorizations.transition(a.authorizationId, a.version, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "SOURCE_REPLACED" } }, now), "the replaced entitlement");
  await publishVersionEvent(
    uow,
    versionEvent("commercial_authorization", a.authorizationId, revoked.version, a.agencyId, { previousState: a.state, state: "REVOKED" }, { authorizationId: a.authorizationId, agencyId: a.agencyId, projectId: a.projectId, captureId: a.captureId, phase: "PRE_EXECUTION", revocationCode: "SOURCE_REPLACED", previousState: a.state }),
    causationId,
  );
}

async function issueReplacement(
  uow: Parameters<PurchaseRebinder["rebind"]>[0],
  input: {
    readonly to: QuoteRecord;
    readonly order: { readonly orderId: CommercialAuthorizationRecord["orderId"]; readonly quoteId: QuoteRecord["quoteId"] };
    readonly capture: { readonly captureId: CommercialAuthorizationRecord["captureId"] };
    readonly rebindingId: PurchaseRebindingId;
    readonly authorizationId: CommercialAuthorizationId;
    readonly subject: { readonly approvalHash: CommercialAuthorizationRecord["approvalHash"]; readonly capabilityId: CommercialAuthorizationRecord["capabilityId"]; readonly capabilityVersion: string };
    readonly now: Parameters<PurchaseRebinder["rebind"]>[1]["now"];
    readonly causationId: Parameters<PurchaseRebinder["rebind"]>[1]["causationId"];
  },
): Promise<void> {
  const { to } = input;
  const issued = await uow.commerce.authorizations.issue({
    authorizationId: input.authorizationId,
    agencyId: to.agencyId,
    projectId: to.projectId,
    quoteId: to.quoteId,
    orderId: input.order.orderId,
    orderQuoteId: input.order.quoteId,
    captureId: input.capture.captureId,
    rebindingId: input.rebindingId,
    approvalId: to.approvalId,
    approvalHash: input.subject.approvalHash,
    planId: to.planId,
    planHash: to.planHash,
    revisionHash: to.revisionHash,
    targetContractHash: to.targetContractHash,
    capabilityId: input.subject.capabilityId,
    capabilityVersion: input.subject.capabilityVersion,
    mode: to.mode,
    billableUnits: to.billableUnits,
    honoredAfterPriceExpiry: false,
    createdAt: input.now,
  });
  await publishVersionEvent(
    uow,
    versionEvent("commercial_authorization", issued.authorizationId, issued.version, to.agencyId, { previousState: null, state: "ACTIVE" }, {
      authorizationId: issued.authorizationId,
      agencyId: to.agencyId,
      projectId: to.projectId,
      quoteId: to.quoteId,
      orderId: input.order.orderId,
      orderQuoteId: input.order.quoteId,
      captureId: input.capture.captureId,
      rebindingId: input.rebindingId,
      approvalId: to.approvalId,
      approvalHash: input.subject.approvalHash,
      planHash: to.planHash,
      revisionHash: to.revisionHash,
      targetContractHash: to.targetContractHash,
      capabilityId: input.subject.capabilityId,
      capabilityVersion: input.subject.capabilityVersion,
      mode: to.mode,
      billableUnits: to.billableUnits,
      honoredAfterPriceExpiry: false,
    }),
    input.causationId,
  );
}

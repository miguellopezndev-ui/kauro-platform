/**
 * CMD048 AssignAccount — POST /api/v1/sales/agencies/{agencyId}/assignment — KAURO_OWNER — scope CORPORATE — no provider effect (design §5,
 * §10, §12; decisions D10-ASSIGN-1, D10-ASSIGN-2; registry "change operational responsibility while preserving historical attribution and
 * earned rights"; R2-095).
 *
 * One unit of work of the owner's OPERATOR context, in B06's pipeline order: access (CommercialAuthorizer: the identity ACTIVE and
 * verified, the caller's own ACTIVE KAURO_OWNER grant after its transition lock) → journal reserve (the operator's own identity-owned
 * entry; or the replay of the journaled 200) → the body, the first failure answering: the seller exists (NOT_FOUND) and is read after the
 * shared half of its transition lock → the agency's sales account FOR UPDATE and expectedVersion (STALE_VERSION with the current version and
 * the reason of the current link; an agency with no account is at version 0 and its first assignment opens it) → the seller ACTIVE
 * (SELLER_NOT_ACTIVE) → the service assignment prepared by the owner for this agency and this seller (SERVICE_ASSIGNMENT_UNPREPARED).
 * Writes: one ASSIGNED link superseding the current one and the account moved to it, version + 1. Nothing else: no assignment row names an
 * allocation, share, claim or entitlement, so the acquisition's window, shares and first designation have no path from this command, and
 * the database refuses their rewrite to every runtime role (KC001, kauro.forbid_column_change). The new owner's compensation for new work
 * is answered from the prepared service assignment (none, or an assistance agreement); a corporate aggregate publishes no event (D10-EVT-1).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AccountAssignmentId, AgencyId, CausationId, SellerId, ServiceAssignmentRef } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, StaleVersionFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { applied } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { ASSIGN_ACCOUNT, type AssignAccountBody } from "../contracts.js";
import type { SalesAccountView } from "../views.js";
import type { SellerCommandCollaborators } from "./runtime.js";

export function assignAccountHandler(runtime: CommerceRequestRuntime, co: SellerCommandCollaborators): CommercialCommandHandler<AssignAccountBody, SalesAccountView> {
  const spec = ASSIGN_ACCOUNT;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<AssignAccountBody>): Promise<CommandResult<SalesAccountView>> {
      const context = operatorContextOf(envelope);
      const agencyId = envelope.path["agencyId"] as AgencyId;
      return runCommerceCommand<AssignAccountBody, SalesAccountView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD048", decision);
        },
        async body(uow, _causationId: CausationId, now: UtcInstant) {
          const body = envelope.body;
          const sales = co.sales(uow);
          const named = await sales.getSeller(body.sellerId as SellerId);
          if (named === null) throw new NotFoundFailure("seller");
          // read after the shared half of the seller's transition lock: a termination in flight is ordered before or after this assignment
          const seller = (await sales.sellerOfIdentity(named.userId)) ?? named;
          const account = await sales.lockSalesAccount(agencyId);
          if (account === null ? body.expectedVersion !== 0 : body.expectedVersion !== account.version) {
            const link = account === null ? null : await sales.currentAssignment(agencyId);
            throw new StaleVersionFailure(account?.version ?? 0, link?.reason ?? "UNASSIGNED");
          }
          if (seller.state !== "ACTIVE") {
            throw new DomainFailure("PRECONDITION_FAILED", "the seller is not ACTIVE: only an active seller is given an agency's operational responsibility", { reason: "SELLER_NOT_ACTIVE" });
          }
          const service = await sales.getServiceAssignment(body.serviceAssignmentRef as ServiceAssignmentRef);
          if (service === null || service.agencyId !== agencyId || service.sellerId !== seller.sellerId) {
            throw new DomainFailure("PRECONDITION_FAILED", "no service assignment prepared for this seller and this agency states the compensation of the new work", { reason: "SERVICE_ASSIGNMENT_UNPREPARED" });
          }
          const moved = applied(
            await sales.assignAccount(
              { assignmentId: uow.ids.next() as AccountAssignmentId, agencyId, sellerId: seller.sellerId, serviceAssignmentRef: service.serviceAssignmentRef, effectiveAt: now },
              account === null ? null : account.version,
              now,
            ),
          );
          const link = await sales.currentAssignment(agencyId);
          if (link === null) throw new DomainFailure("INTEGRITY_FAILURE", "the sales account names no assignment after an assignment");
          return {
            status: 200,
            view: {
              agencyId,
              version: moved.version,
              sellerId: seller.sellerId,
              assignedAt: link.effectiveAt,
              newWorkCompensation: service.compensation,
              ...(service.assistanceAgreementId !== undefined ? { assistanceAgreementId: service.assistanceAgreementId } : {}),
            },
            version: moved.version,
            resourceKind: "sales_account",
            resourceId: agencyId,
          };
        },
      });
    },
  };
}

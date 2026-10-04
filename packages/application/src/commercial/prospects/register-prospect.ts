/**
 * CMD045 RegisterProspect — POST /api/v1/sales/prospects — an ACTIVE seller or the corporate owner — scope CORPORATE — no provider effect
 * (design §5 "Prospects", §12; decision D10-PROS-1; registry "create a minimized prospect without granting customer data access or
 * automatic attribution"; "a suppressed identity cannot be reactivated through spelling or duplicate-list import").
 *
 * One unit of work of the caller's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE seller row, else its own
 * ACTIVE KAURO_OWNER grant, each read after its transition lock) → journal reserve (or the replay of the journaled 201) → the body, the
 * first failure answering: the organization label names a business domain (its key is KAURO_PROSPECT_ORGANIZATION_V1 of the normalized
 * domain, so every spelling of one domain has one key) → the caller's own AGENCY-segment source evidence and business contact
 * (SOURCE_EVIDENCE_INVALID; another seller's evidence and another segment are as unknown as a missing one) → no suppression by the
 * organization key or the contact key (PROSPECT_SUPPRESSED) → no live prospect of the key (PROSPECT_EXISTS; a prospect another seller
 * registered is invisible to the caller, so the live-prospect unique index answers for it after waiting for the other transaction).
 * Writes the prospect born RESEARCHED at version 1, owned by the registering seller; no claim, no attribution, no customer data. The
 * journaled view carries no contact detail.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { ProspectContactRef, ProspectId, SellerId, UserId } from "@kauro/domain";
import { DomainFailure, organizationKeyOf } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { REGISTER_PROSPECT, type RegisterProspectBody } from "../contracts.js";
import type { ProspectView } from "../views.js";
import type { ProspectCollaborators } from "./runtime.js";

export function registerProspectHandler(runtime: CommerceRequestRuntime, co: ProspectCollaborators): CommercialCommandHandler<RegisterProspectBody, ProspectView> {
  const spec = REGISTER_PROSPECT;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RegisterProspectBody>): Promise<CommandResult<ProspectView>> {
      const context = operatorContextOf(envelope);
      let sellerId: SellerId | null = null;
      return runCommerceCommand<RegisterProspectBody, ProspectView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const asSeller = await co.authorizer.authorizeSeller(uow, { identity: envelope.subject.identity });
          if (asSeller.kind === "ALLOW") {
            sellerId = asSeller.sellerId as SellerId;
            return;
          }
          // a person without an ACTIVE seller row may still be the owner; any other refusal (identity, authentication) is the seller check's own
          if (asSeller.reason !== "CORPORATE_ROLE_MISSING") throw CommerceAccessDenied.of("CMD045", asSeller);
          const asOwner = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (asOwner.kind === "DENY") throw CommerceAccessDenied.of("CMD045", asOwner);
        },
        async body(uow, _causationId, now: UtcInstant) {
          const body = envelope.body;
          const sales = co.sales(uow);
          const organization = organizationKeyOf(body.organizationLabel);
          if (organization === null) {
            throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field: "organizationLabel", code: "FORMAT" }] });
          }
          const evidence = await sales.sourceEvidence(body.sourceEvidenceHash as Sha256Hex);
          if (evidence === null || evidence.segment !== "AGENCY" || (sellerId !== null && evidence.recordedBySellerId !== sellerId)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the source evidence is not the caller's own AGENCY-segment evidence", { reason: "SOURCE_EVIDENCE_INVALID" });
          }
          const contact = await sales.getContact(body.businessContactRef as ProspectContactRef);
          if (contact === null) throw new DomainFailure("PRECONDITION_FAILED", "the business contact is not the caller's own", { reason: "SOURCE_EVIDENCE_INVALID" });
          if ((await sales.suppressionOf(organization.key, contact.contactKey)) !== null) {
            throw new DomainFailure("PRECONDITION_FAILED", "the organization or its contact is suppressed", { reason: "PROSPECT_SUPPRESSED" });
          }
          if ((await sales.liveProspectOf(organization.key)) !== null) {
            throw new DomainFailure("PRECONDITION_FAILED", "the organization already has a live prospect", { reason: "PROSPECT_EXISTS" });
          }
          const prospect = await sales.registerProspect({
            prospectId: uow.ids.next() as ProspectId,
            organizationLabel: body.organizationLabel,
            organizationKey: organization.key,
            businessContactRef: body.businessContactRef as ProspectContactRef,
            sourceEvidenceHash: body.sourceEvidenceHash as Sha256Hex,
            jurisdiction: body.jurisdiction,
            ...(sellerId !== null ? { ownerSellerId: sellerId } : {}),
            registeredByUserId: envelope.userId as UserId,
            createdAt: now,
          });
          return {
            status: 201,
            view: {
              prospectId: prospect.prospectId,
              organizationLabel: prospect.organizationLabel,
              sourceEvidenceHash: prospect.sourceEvidenceHash,
              jurisdiction: prospect.jurisdiction,
              state: prospect.state,
              suppressed: prospect.suppressed,
              ...(prospect.ownerSellerId !== undefined ? { ownerSellerId: prospect.ownerSellerId } : {}),
            },
            version: prospect.version,
            resourceKind: "prospect",
            resourceId: prospect.prospectId,
          };
        },
      });
    },
  };
}

/**
 * RecordProspectContact — POST /api/v1/ops/prospects/{prospectId}/contacts — an ACTIVE seller (its own prospect) or the corporate owner —
 * scope CORPORATE — no provider effect (plan docs/design/B12-outreach-plan-cells.md §R, B12-2; policy 0029 prospect_contacts_record).
 *
 * One unit of work of the caller's OPERATOR context, in B06's pipeline order: access (seller, else owner, each read after its transition
 * lock L1: GAP-PK-2) → journal reserve (or the replay of the journaled 201) → the prospect (a seller sees the prospects it owns; a foreign
 * and an unknown one answer alike, NOT_FOUND; a SUPPRESSED prospect takes no contact, PROSPECT_SUPPRESSED) → the address is a business
 * address (SCHEMA_VIOLATION otherwise) and its key is KAURO_PROSPECT_CONTACT_V1 of the case-folded NFC address, whoever records it
 * (A14): two recorders of one address hold two contact rows and one key (GAP-PK-1, a unique-free record by design), so a suppression of
 * the key survives reimport, reassignment and provider change. The contact row and its restricted address are written in this one
 * transaction (GAP-PK-3). The view carries no address and no key. A recorded key that is already suppressed is stored like any other:
 * CMD045, CMD061 and CMD063 refuse it (KC016); the key is never read to rank (D-33).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { ProspectId, SellerId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { RECORD_PROSPECT_CONTACT, type RecordProspectContactBody } from "../contracts.js";
import type { ProspectContactView } from "../views.js";
import { contactKey } from "./contact-key.js";
import type { ProspectCollaborators } from "./runtime.js";

export function recordContactHandler(runtime: CommerceRequestRuntime, co: ProspectCollaborators): CommercialCommandHandler<RecordProspectContactBody, ProspectContactView> {
  const spec = RECORD_PROSPECT_CONTACT;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RecordProspectContactBody>): Promise<CommandResult<ProspectContactView>> {
      const context = operatorContextOf(envelope);
      const prospectId = envelope.path["prospectId"] as ProspectId;
      let sellerId: SellerId | null = null;
      return runCommerceCommand<RecordProspectContactBody, ProspectContactView>(runtime, {
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
          if (asSeller.reason !== "CORPORATE_ROLE_MISSING") throw CommerceAccessDenied.of("RecordProspectContact", asSeller);
          const asOwner = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (asOwner.kind === "DENY") throw CommerceAccessDenied.of("RecordProspectContact", asOwner);
        },
        async body(uow, _causationId, _now: UtcInstant) {
          const body = envelope.body;
          const sales = co.sales(uow);
          const prospect = await sales.getProspect(prospectId);
          if (prospect === null || (sellerId !== null && prospect.ownerSellerId !== sellerId)) throw new NotFoundFailure("prospect");
          if (prospect.suppressed || prospect.state === "SUPPRESSED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the prospect is suppressed and takes no contact", { reason: "PROSPECT_SUPPRESSED" });
          }
          const key = contactKey(body.address);
          if (key === null) {
            throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field: "address", code: "FORMAT" }] });
          }
          const contact = await sales.recordContact({
            contactId: uow.ids.next(),
            contactKey: key.key,
            contactLabel: body.contactLabel,
            ...(body.roleLabel !== undefined ? { roleLabel: body.roleLabel } : {}),
            channel: body.channel,
            address: key.address,
          });
          return {
            status: 201,
            view: { contactId: contact.contactRef, channel: body.channel, createdAt: contact.recordedAt } as ProspectContactView,
            version: 1,
            resourceKind: "prospect_contact",
            resourceId: contact.contactRef,
          };
        },
      });
    },
  };
}

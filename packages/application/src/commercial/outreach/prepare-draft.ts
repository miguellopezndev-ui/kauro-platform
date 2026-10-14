/**
 * CMD061 PrepareOutreachDraft — POST /api/v1/ops/outreach/drafts — an ASSIGNED_SELLER_OR_OWNER — no provider effect (package B12, lane
 * L-DRAFT; plan docs/design/B12-outreach-plan.md §0 A1, A8, A13, A15, §L CMD061 trace, §M M11/M13/M24/M39; registry OutreachDraft "The draft
 * is a proposal").
 *
 * One unit of work of the caller's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE seller row, else its own
 * ACTIVE KAURO_OWNER grant: L1, read after its transition lock) → journal reserve (L2) or the replay of the journaled 201 → the body: the
 * store takes L3 S, L5 S, L6 S, L6p S, L7 S, L8 S, L10 X, judges at the database's instant (sender VERIFIED and not REVOKED, policy of the
 * prospect's jurisdiction and purpose in force, contact and organization not suppressed, every cited resource CURRENT with its capabilities
 * offered) and writes the draft (DRAFT, version 1, content hash = the recipient/sender/purpose/body binding) with its cited resources.
 * Nothing else is born: no intent, outbox record, activity, event or provider call (A1). A prospect, sender, provenance, content or resource
 * the caller cannot see answers NOT_FOUND exactly like an id nobody holds. A RESEND_TRANSACTIONAL sender is admitted here (the draft is a
 * proposal); CMD063 and the database refuse its send (KC028).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CausationId } from "@kauro/domain";
import { DomainFailure, isUuid } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { B12_COMMERCIAL_COMMANDS, type PrepareOutreachDraftBody } from "../contracts.js";
import type { OutreachDraftView } from "../views.js";
import { sellerOrOwner } from "./draft-access.js";
import type { DraftActor, DraftPurpose, OutreachDraftCollaborators } from "./draft-store.js";

const spec = B12_COMMERCIAL_COMMANDS.CMD061;

export const PREPARE_OUTREACH_DRAFT_OPERATION = "CMD061";

const PURPOSES: ReadonlySet<string> = new Set<DraftPurpose>(["REQUESTED_REPLY", "INDIVIDUAL_PROSPECT_CONTACT", "FOLLOW_UP"]);

function refuseShape(field: string, code: "FORMAT" | "ENUM"): never {
  throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code }] });
}

export function prepareDraftHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): CommercialCommandHandler<PrepareOutreachDraftBody, OutreachDraftView> {
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<PrepareOutreachDraftBody>): Promise<CommandResult<OutreachDraftView>> {
      const context = operatorContextOf(envelope);
      let actor: DraftActor | null = null;
      return runCommerceCommand<PrepareOutreachDraftBody, OutreachDraftView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          actor = await sellerOrOwner(co.authorizer, uow, envelope.subject.identity, PREPARE_OUTREACH_DRAFT_OPERATION);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          if (actor === null) throw new DomainFailure("INTEGRITY_FAILURE", "a draft was authorized without an actor");
          const body = envelope.body;
          if (!isUuid(body.prospectId)) refuseShape("prospectId", "FORMAT");
          if (!isUuid(body.senderIdentityRef)) refuseShape("senderIdentityRef", "FORMAT");
          if (!PURPOSES.has(body.purpose)) refuseShape("purpose", "ENUM");
          const resourceIds = body.resourceIds ?? [];
          if (!resourceIds.every((id) => isUuid(id))) refuseShape("resourceIds", "FORMAT");
          const draftId = uow.ids.next();
          const store = co.drafts(uow);
          const prepared = await store.prepareDraft({
            draftId,
            actor,
            prospectId: body.prospectId,
            senderId: body.senderIdentityRef,
            purpose: body.purpose,
            contentRef: body.contentRef,
            provenanceEvidenceHash: body.provenanceEvidenceHash,
            resourceIds,
          });
          const record = await store.draftOf(prepared.draftId);
          if (record === null) throw new DomainFailure("INTEGRITY_FAILURE", "the prepared draft cannot be read back");
          const view: OutreachDraftView = {
            draftId: record.draftId,
            prospectId: record.prospectId,
            senderIdentityRef: record.senderId,
            purpose: record.purpose,
            contentHash: record.contentHash as Sha256Hex,
            contentRef: record.contentRef as Sha256Hex,
            provenanceEvidenceHash: record.provenanceEvidenceHash as Sha256Hex,
            version: record.version,
            state: record.state as OutreachDraftView["state"],
            createdAt: record.createdAt as UtcInstant,
          };
          return { status: 201, view, version: record.version, resourceKind: "outreach_draft", resourceId: record.draftId };
        },
      });
    },
  };
}

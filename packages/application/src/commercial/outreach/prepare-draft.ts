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
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId } from "@kauro/domain";
import { DomainFailure, isUuid } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { sellerOrOwner } from "./draft-access.js";
import type { DraftActor, DraftCommandHandler, DraftPurpose, OutreachDraftCollaborators, PreparedDraftView } from "./draft-store.js";

export interface PrepareOutreachDraftBody {
  readonly prospectId: string;
  readonly senderIdentityRef: string;
  readonly purpose: DraftPurpose;
  readonly contentRef: string;
  readonly provenanceEvidenceHash: string;
  /** The sales resources the draft cites (plan A8). */
  readonly resourceIds: ReadonlyArray<string>;
}

export const PREPARE_OUTREACH_DRAFT_OPERATION = "CMD061";

const PURPOSES: ReadonlySet<string> = new Set<DraftPurpose>(["REQUESTED_REPLY", "INDIVIDUAL_PROSPECT_CONTACT", "FOLLOW_UP"]);

function refuseShape(field: string, code: "FORMAT" | "ENUM"): never {
  throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code }] });
}

export function prepareDraftHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): DraftCommandHandler<PrepareOutreachDraftBody, PreparedDraftView> {
  return {
    operation: PREPARE_OUTREACH_DRAFT_OPERATION,
    async execute(envelope: CommandEnvelope<PrepareOutreachDraftBody>): Promise<CommandResult<PreparedDraftView>> {
      const context = operatorContextOf(envelope);
      let actor: DraftActor | null = null;
      return runCommerceCommand<PrepareOutreachDraftBody, PreparedDraftView>(runtime, {
        command: { id: PREPARE_OUTREACH_DRAFT_OPERATION, journalScope: "OPERATOR_IDENTITY" },
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
          if (!body.resourceIds.every((id) => isUuid(id))) refuseShape("resourceIds", "FORMAT");
          const draftId = uow.ids.next();
          const prepared = await co.drafts(uow).prepareDraft({
            draftId,
            actor,
            prospectId: body.prospectId,
            senderId: body.senderIdentityRef,
            purpose: body.purpose,
            contentRef: body.contentRef,
            provenanceEvidenceHash: body.provenanceEvidenceHash,
            resourceIds: body.resourceIds,
          });
          return { status: 201, view: prepared, version: prepared.version, resourceKind: "outreach_draft", resourceId: prepared.draftId };
        },
      });
    },
  };
}

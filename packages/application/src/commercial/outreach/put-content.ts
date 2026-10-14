/**
 * PutOutreachContent — POST /api/v1/ops/outreach/contents — an ACTIVE seller or the corporate owner — no provider effect (package B12, lane
 * L-DRAFT; plan docs/design/B12-outreach-plan.md §0 A13, A17; companion B12-outreach-plan-cells.md §R Put row, §T content checks).
 *
 * One unit of work of the caller's OPERATOR context: access (L1) → journal reserve (L2) or the replay → the content checks of
 * content-checks.ts (422 CONTENT_REFUSED naming every broken rule's field, nothing stored) → the content-addressed insert (the id is the
 * sha256 of the KAURO_OUTREACH_CONTENT_V1 line over subject and body; a second put of the same text, by anyone, is the same id and writes
 * nothing). The stored text is what a draft cites by `contentRef`; it never holds customer records (A17), which the checks and the draft's
 * reference-only binding keep out.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId } from "@kauro/domain";
import { DomainFailure, outreachContentId } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { contentChecks, type ContentRule } from "./content-checks.js";
import { sellerOrOwner } from "./draft-access.js";
import type { DraftActor, DraftCommandHandler, OutreachContentView, OutreachDraftCollaborators } from "./draft-store.js";

export interface PutOutreachContentBody {
  readonly subject: string;
  readonly body: string;
}

export const PUT_OUTREACH_CONTENT_OPERATION = "PutOutreachContent";

/** The request field and code each rule is reported under (no customer value is echoed). */
const RULE_FIELD: Readonly<Record<ContentRule, { readonly field: "subject" | "body"; readonly code: "FORMAT" | "RANGE" }>> = {
  SUBJECT_LENGTH: { field: "subject", code: "RANGE" },
  SUBJECT_CONTROL: { field: "subject", code: "FORMAT" },
  NOT_NFC: { field: "body", code: "FORMAT" },
  BODY_LENGTH: { field: "body", code: "RANGE" },
  SAVINGS_AMOUNT: { field: "body", code: "FORMAT" },
  GUARANTEE: { field: "body", code: "FORMAT" },
  AI_IN_SUBJECT: { field: "subject", code: "FORMAT" },
  AI_SENTENCES: { field: "body", code: "FORMAT" },
};

/** The sha256 content id as the uuid column of the journal (resource_id): its first 128 bits, deterministic, so a replay names the same row. */
const journalIdOf = (contentId: string): string => `${contentId.slice(0, 8)}-${contentId.slice(8, 12)}-${contentId.slice(12, 16)}-${contentId.slice(16, 20)}-${contentId.slice(20, 32)}`;

/** The storage limits the content rules do not name: an empty text and a NUL are not text the table keeps. */
function refuseUnstorable(content: PutOutreachContentBody): void {
  const fields: Array<{ field: string; code: "RANGE" | "FORMAT" }> = [];
  if (content.subject.length === 0) fields.push({ field: "subject", code: "RANGE" });
  if (content.body.length === 0) fields.push({ field: "body", code: "RANGE" });
  if (content.body.includes("\u0000")) fields.push({ field: "body", code: "FORMAT" });
  if (fields.length > 0) throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields });
}

export function putContentHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): DraftCommandHandler<PutOutreachContentBody, OutreachContentView> {
  return {
    operation: PUT_OUTREACH_CONTENT_OPERATION,
    async execute(envelope: CommandEnvelope<PutOutreachContentBody>): Promise<CommandResult<OutreachContentView>> {
      const context = operatorContextOf(envelope);
      let actor: DraftActor | null = null;
      return runCommerceCommand<PutOutreachContentBody, OutreachContentView>(runtime, {
        command: { id: PUT_OUTREACH_CONTENT_OPERATION, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          actor = await sellerOrOwner(co.authorizer, uow, envelope.subject.identity, PUT_OUTREACH_CONTENT_OPERATION);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          if (actor === null) throw new DomainFailure("INTEGRITY_FAILURE", "a content was authorized without an actor");
          const content = envelope.body;
          refuseUnstorable(content);
          const verdict = contentChecks(content);
          if (verdict.refused.length > 0) {
            const fields = verdict.refused.map((rule) => RULE_FIELD[rule]);
            throw new DomainFailure("CONTENT_REFUSED", `the outreach content breaks ${verdict.refused.join(", ")}: nothing was stored`, { fields });
          }
          const contentId = await co.drafts(uow).putContent(content, actor.userId);
          if (contentId !== outreachContentId(content.subject, content.body)) throw new DomainFailure("INTEGRITY_FAILURE", "the stored content id is not the content's address");
          return { status: 201, view: { contentId }, version: 1, resourceKind: "outreach_content", resourceId: journalIdOf(contentId) };
        },
      });
    },
  };
}

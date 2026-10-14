/**
 * RecordProspectSource — POST /api/v1/ops/prospects/{prospectId}/sources — an ACTIVE seller (its own prospect) or the corporate owner —
 * scope CORPORATE — no provider effect (plan docs/design/B12-outreach-plan-cells.md §R, B12-1; policy 0029 prospect_source_evidence_record).
 *
 * One unit of work of the caller's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE seller row, else its own ACTIVE
 * KAURO_OWNER grant, each read after its transition lock, L1: a seller TERMINATED by CMD050 is refused in both orders, GAP-PS-1) → journal
 * reserve (or the replay of the journaled 201) → the prospect (a seller sees the prospects it owns; a foreign and an unknown one answer alike,
 * NOT_FOUND) → the observation is not dated after the database instant (GAP-PS-2, SOURCE_EVIDENCE_INVALID) → the evidence is appended
 * (content-addressed per recorder: the same hash with the same facts answers the stored row, other facts are SOURCE_EVIDENCE_INVALID).
 * The segment (AGENCY or COMPANY, D-33) is stored and never read for ranking. The view carries no source URL, only its digest travels in.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { ProspectId, ProspectSegment, SellerId } from "@kauro/domain";
import { COMMERCIAL_VOCABULARY, DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { RECORD_PROSPECT_SOURCE, type RecordProspectSourceBody } from "../contracts.js";
import type { ProspectSourceView } from "../views.js";
import type { ProspectCollaborators } from "./runtime.js";

const SEGMENTS: ReadonlySet<string> = new Set(COMMERCIAL_VOCABULARY.prospectSegments);

/** Whether a YYYY-MM-DD text names a real calendar day. */
function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === text;
}

export function recordSourceHandler(runtime: CommerceRequestRuntime, co: ProspectCollaborators): CommercialCommandHandler<RecordProspectSourceBody, ProspectSourceView> {
  const spec = RECORD_PROSPECT_SOURCE;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RecordProspectSourceBody>): Promise<CommandResult<ProspectSourceView>> {
      const context = operatorContextOf(envelope);
      const prospectId = envelope.path["prospectId"] as ProspectId;
      let sellerId: SellerId | null = null;
      return runCommerceCommand<RecordProspectSourceBody, ProspectSourceView>(runtime, {
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
          if (asSeller.reason !== "CORPORATE_ROLE_MISSING") throw CommerceAccessDenied.of("RecordProspectSource", asSeller);
          const asOwner = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (asOwner.kind === "DENY") throw CommerceAccessDenied.of("RecordProspectSource", asOwner);
        },
        async body(uow, _causationId, now: UtcInstant) {
          const body = envelope.body;
          const sales = co.sales(uow);
          const prospect = await sales.getProspect(prospectId);
          if (prospect === null || (sellerId !== null && prospect.ownerSellerId !== sellerId)) throw new NotFoundFailure("prospect");
          if (!SEGMENTS.has(body.segment) || !isCalendarDate(body.observedOn) || body.observedOn > now.slice(0, 10)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the observation is dated after the database instant or names no day", { reason: "SOURCE_EVIDENCE_INVALID" });
          }
          const stored = await sales.sourceEvidence(body.evidenceHash as Sha256Hex);
          const evidence =
            stored !== null
              ? stored
              : await sales.recordSourceEvidence({
                  evidenceId: uow.ids.next(),
                  evidenceHash: body.evidenceHash as Sha256Hex,
                  sourceUrlDigest: body.sourceUrlDigest as Sha256Hex,
                  observedOn: body.observedOn,
                  lawfulBasis: body.lawfulBasis,
                  segment: body.segment as ProspectSegment,
                  ...(sellerId !== null ? { sellerId } : {}),
                });
          if (stored !== null && (stored.sourceUrlDigest !== body.sourceUrlDigest || stored.observedOn !== body.observedOn || stored.lawfulBasis !== body.lawfulBasis || stored.segment !== body.segment)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the evidence hash is already recorded with other facts", { reason: "SOURCE_EVIDENCE_INVALID" });
          }
          return {
            status: 201,
            view: { evidenceId: evidence.evidenceId, evidenceHash: evidence.evidenceHash, observedOn: evidence.observedOn, segment: evidence.segment, createdAt: evidence.recordedAt } as ProspectSourceView,
            version: 1,
            resourceKind: "prospect_source",
            resourceId: evidence.evidenceId,
          };
        },
      });
    },
  };
}

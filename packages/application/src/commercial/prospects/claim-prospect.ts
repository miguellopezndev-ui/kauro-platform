/**
 * CMD046 ClaimProspect — POST /api/v1/sales/prospects/{prospectId}/claims — an ACTIVE seller — scope CORPORATE — no provider effect
 * (design §5 "Claims", §12; decision D10-CLAIM-1, D10-CLAIM-2; registry "create a reviewable attribution claim"; "submission alone does
 * not own the agency"; "existing accepted claims or customer history route to conflict review").
 *
 * One unit of work of the seller's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE seller row, read after its
 * transition lock; an owner or an agency member holds none: CORPORATE_ROLE_MISSING) → journal reserve (or the replay of the journaled
 * 201) → the body, the first failure answering: the prospect, taken under the writer's half of its claims lock — claims of one prospect
 * serialize, so what follows is read after every earlier claim committed — and visible to the seller only while it owns it (a foreign
 * and a nonexistent prospect answer alike: NOT_FOUND) → the seller's agreement in force carries the version the request names
 * (AGREEMENT_VERSION_MISMATCH) → the claim evidence is the seller's own for this prospect and substantive (a list import or a tracking
 * link alone is CLAIM_EVIDENCE_INSUFFICIENT) → the seller has no live claim on the prospect (CLAIM_EXISTS). Then the conflict review in
 * the same transaction: another seller's live claim, an accepted claim on the organization or an agency with an order or purchase
 * writes the claim DISPUTED with its reason instead of SUBMITTED. The claim owns nothing: no allocation, no entitlement, no agency; its
 * review deadline is 2160 hours after the server's instant (the database sets both).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AttributionClaimId, ProspectId, SellerId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { CLAIM_PROSPECT, type ClaimProspectBody } from "../contracts.js";
import type { AttributionClaimView } from "../views.js";
import type { ProspectCollaborators } from "./runtime.js";
import { claimView } from "./shared.js";

/** The activity kinds that alone are not substantive evidence of acquisition work (17 "Claim validity and conflicts"). */
const NON_SUBSTANTIVE: ReadonlySet<string> = new Set(["LIST_IMPORT", "TRACKING_LINK"]);

/** The reason token a DISPUTED claim is born with, by the first conflict the review found. */
export const CLAIM_CONFLICT_REASONS = Object.freeze({ ACCEPTED_CLAIM: "ACCEPTED_CLAIM_ON_ORGANIZATION", COMPETING_CLAIM: "LIVE_COMPETING_CLAIM", CUSTOMER_HISTORY: "AGENCY_CUSTOMER_HISTORY" } as const);

export function claimProspectHandler(runtime: CommerceRequestRuntime, co: ProspectCollaborators): CommercialCommandHandler<ClaimProspectBody, AttributionClaimView> {
  const spec = CLAIM_PROSPECT;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<ClaimProspectBody>): Promise<CommandResult<AttributionClaimView>> {
      const context = operatorContextOf(envelope);
      const prospectId = envelope.path["prospectId"] as ProspectId;
      let sellerId: SellerId | null = null;
      return runCommerceCommand<ClaimProspectBody, AttributionClaimView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeSeller(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD046", decision);
          sellerId = decision.sellerId as SellerId;
        },
        async body(uow, _causationId, now: UtcInstant) {
          if (sellerId === null) throw new DomainFailure("INTEGRITY_FAILURE", "a claim was authorized without a seller");
          const body = envelope.body;
          const sales = co.sales(uow);
          const attribution = co.attribution(uow);
          const prospect = await sales.lockProspect(prospectId);
          if (prospect === null || prospect.ownerSellerId !== sellerId) throw new NotFoundFailure("prospect");
          const agreement = await sales.agreementInForce(sellerId, now);
          if (agreement === null || agreement.agreementVersion !== body.agreementVersion) {
            throw new DomainFailure("PRECONDITION_FAILED", "agreementVersion is not the seller's agreement version in force", { reason: "AGREEMENT_VERSION_MISMATCH" });
          }
          const evidence = await attribution.claimEvidence(body.evidenceHash as Sha256Hex);
          if (evidence === null || evidence.prospectId !== prospectId || !evidence.activityKinds.some((kind) => !NON_SUBSTANTIVE.has(kind))) {
            throw new DomainFailure("PRECONDITION_FAILED", "the claim evidence is not substantive work of the seller on this prospect", { reason: "CLAIM_EVIDENCE_INSUFFICIENT" });
          }
          const own = await attribution.claimsOfProspect(prospectId);
          if (own.some((c) => c.sellerId === sellerId && (c.state === "SUBMITTED" || c.state === "DISPUTED" || c.state === "ACCEPTED"))) {
            throw new DomainFailure("PRECONDITION_FAILED", "the seller already has a live claim on the prospect", { reason: "CLAIM_EXISTS" });
          }
          const conflicts = await attribution.claimConflicts(prospectId, sellerId);
          const conflict = conflicts.acceptedClaimOnOrganization
            ? CLAIM_CONFLICT_REASONS.ACCEPTED_CLAIM
            : conflicts.otherSellersLiveClaim
              ? CLAIM_CONFLICT_REASONS.COMPETING_CLAIM
              : conflicts.customerHistory
                ? CLAIM_CONFLICT_REASONS.CUSTOMER_HISTORY
                : null;
          const claim = await attribution.submitClaim({
            claimId: uow.ids.next() as AttributionClaimId,
            prospectId,
            sellerId,
            agreementId: agreement.agreementId,
            agreementVersion: agreement.agreementVersion,
            evidenceHash: body.evidenceHash as Sha256Hex,
            state: conflict === null ? "SUBMITTED" : "DISPUTED",
            ...(conflict !== null ? { conflictReason: conflict } : {}),
            submittedAt: now,
            reviewDeadlineAt: now,
          });
          return { status: 201, view: claimView(claim), version: claim.version, resourceKind: "attribution_claim", resourceId: claim.claimId };
        },
      });
    },
  };
}

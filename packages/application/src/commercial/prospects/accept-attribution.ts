/**
 * CMD047 AcceptAttribution — POST /api/v1/sales/claims/{claimId}/accept — KAURO_OWNER — scope CORPORATE — no provider effect (design §5
 * "Attribution", §12; decisions D10-ATTR-1, D58; registry "freeze accepted acquisition attribution and claim window; record any agreed
 * split totaling 100%"; "assignment edits or two full-rate sellers cannot duplicate the commission pool").
 *
 * One unit of work of the owner's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE KAURO_OWNER grant, read
 * after its transition lock) → journal reserve (or the replay of the journaled 200) → the body, the first failure answering: the claim,
 * taken after the writer's half of its prospect's claims lock (NOT_FOUND for an unknown id) → expectedVersion (STALE_VERSION) → its review
 * deadline not reached on the database clock (CLAIM_EXPIRED, under review or lapsed; also for every share's claim) → the claim is SUBMITTED or DISPUTED (CLAIM_NOT_REVIEWABLE) → the owner-prepared allocation shareAllocationRef is on this claim's prospect and
 * unfrozen (NOT_FOUND; ATTRIBUTION_EXISTS) → names a share for this claim and its shares sum to exactly 10 000 bps (SHARES_NOT_WHOLE) →
 * the agency has no frozen allocation (ATTRIBUTION_EXISTS: the pool does not become 10% for each seller) → the agency's buyer type,
 * read through BuyerTypeReader (unset: BUYER_TYPE_UNSET; IN_HOUSE: IN_HOUSE_NOT_ATTRIBUTABLE; D58) → no payment order of the agency
 * precedes the claim (CLAIM_AFTER_FIRST_ORDER), read in the agency's finance scope. Writes: every beneficiary claim ACCEPTED, running
 * 2160 hours from the server's instant, every other live claim of the prospect REJECTED by the allocation, and the allocation frozen
 * once (its shares sum to 10 000 bps at COMMIT, KC003). The answer names the decision by a server token, never by the owner's ruling text.
 * The corporate machines publish no domain event (D10-EVT-2).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AttributionAllocationId, AttributionClaimId, AttributionClaimRecord } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { applied, checkExpectedVersion } from "../../commands/handlers/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { ACCEPT_ATTRIBUTION, type AcceptAttributionBody } from "../contracts.js";
import type { AttributionView } from "../views.js";
import type { ProspectCollaborators } from "./runtime.js";
import { claimView } from "./shared.js";

/** The shares of a frozen allocation sum to exactly this many basis points (D10-ATTR-1). */
export const ALLOCATION_TOTAL_BPS = 10_000;

const REVIEWABLE: ReadonlySet<string> = new Set(["SUBMITTED", "DISPUTED"]);

/** The server tokens that say why a claim was accepted; the owner's own ruling text stays with the allocation and never leaves in an answer. */
export const DECISION_REASONS = Object.freeze({ CONFLICT_RESOLVED: "CONFLICT_RESOLVED_BY_RULING", AGREED_SPLIT: "AGREED_SPLIT", COMPETITORS_REJECTED: "COMPETING_CLAIMS_REJECTED", SOLE_CLAIM: "SOLE_CLAIM_ACCEPTED" } as const);

export function acceptAttributionHandler(runtime: CommerceRequestRuntime, co: ProspectCollaborators): CommercialCommandHandler<AcceptAttributionBody, AttributionView> {
  const spec = ACCEPT_ATTRIBUTION;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<AcceptAttributionBody>): Promise<CommandResult<AttributionView>> {
      const context = operatorContextOf(envelope);
      const claimId = envelope.path["claimId"] as AttributionClaimId;
      return runCommerceCommand<AcceptAttributionBody, AttributionView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD047", decision);
        },
        async body(uow, _causationId, now: UtcInstant) {
          const body = envelope.body;
          const attribution = co.attribution(uow);
          const refuseLapsed = async (c: AttributionClaimRecord, named: boolean): Promise<void> => {
            if ((REVIEWABLE.has(c.state) || c.state === "EXPIRED") && (await attribution.reviewDeadlineReached(c.claimId))) {
              throw new DomainFailure("PRECONDITION_FAILED", "the claim's review deadline has passed", named ? { reason: "CLAIM_EXPIRED", currentVersion: c.version, currentState: c.state } : { reason: "CLAIM_EXPIRED" });
            }
          };
          // the global order (D10-GAP-20): the allocation's agency before the claims (a claim's acceptance takes the agency's foreign-key lock)
          const prepared = await attribution.getAllocation(body.shareAllocationRef as AttributionAllocationId);
          if (prepared !== null) await attribution.lockAgencies([prepared.agencyId]);
          const claim = await attribution.lockClaim(claimId);
          if (claim === null) throw new NotFoundFailure("claim");
          checkExpectedVersion(claim, body.expectedVersion);
          // the review deadline at the database's instant of this statement (kauro.effect_now(), so after the agency and claim locks this unit waited on;
          // the CLAIM_WINDOWS lapse's comparison): a claim under review or lapsed past it is CLAIM_EXPIRED whether or not the sweep has run yet
          await refuseLapsed(claim, true);
          if (!REVIEWABLE.has(claim.state)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the claim is not under review", { reason: "CLAIM_NOT_REVIEWABLE", currentVersion: claim.version, currentState: claim.state });
          }
          const allocation = await attribution.getAllocation(body.shareAllocationRef as AttributionAllocationId);
          if (allocation === null || allocation.prospectId !== claim.prospectId) throw new NotFoundFailure("allocation");
          if (allocation.frozenAt !== undefined) throw new DomainFailure("PRECONDITION_FAILED", "the allocation is already frozen", { reason: "ATTRIBUTION_EXISTS" });
          const total = allocation.shares.reduce((sum, share) => sum + share.shareBps, 0);
          if (total !== ALLOCATION_TOTAL_BPS) {
            throw new DomainFailure("PRECONDITION_FAILED", "the allocation's shares do not sum to 10000 basis points", { reason: "SHARES_NOT_WHOLE" });
          }
          if (!allocation.shares.some((share) => share.claimId === claim.claimId)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the allocation names no share for this claim", { reason: "SHARES_NOT_WHOLE" });
          }
          if ((await attribution.frozenAllocationOf(allocation.agencyId)) !== null) {
            throw new DomainFailure("PRECONDITION_FAILED", "the agency already has a frozen attribution allocation", { reason: "ATTRIBUTION_EXISTS" });
          }
          const buyerType = await co.buyerTypes.buyerTypeOf(uow, { agencyId: allocation.agencyId });
          if (buyerType === null) throw new DomainFailure("PRECONDITION_FAILED", "the agency's buyer type is not recorded", { reason: "BUYER_TYPE_UNSET" });
          if (buyerType === "IN_HOUSE") throw new DomainFailure("PRECONDITION_FAILED", "an in-house tenant earns no seller attribution", { reason: "IN_HOUSE_NOT_ATTRIBUTABLE" });
          await uow.adoptFinanceScope(allocation.agencyId);
          if (await co.orderPrecedesClaim(uow, allocation.agencyId, claim.claimId)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the claim was submitted after the agency's first payment order", { reason: "CLAIM_AFTER_FIRST_ORDER" });
          }
          // the beneficiaries' claims, then the prospect's other live claims the allocation rules against
          const beneficiaries = new Map<string, AttributionClaimRecord>();
          for (const share of allocation.shares) {
            const shareClaim: AttributionClaimRecord | null = share.claimId === claim.claimId ? claim : await attribution.lockClaim(share.claimId);
            if (shareClaim !== null && shareClaim.prospectId === claim.prospectId && shareClaim !== claim) await refuseLapsed(shareClaim, false);
            if (shareClaim === null || shareClaim.prospectId !== claim.prospectId || !REVIEWABLE.has(shareClaim.state)) {
              throw new DomainFailure("PRECONDITION_FAILED", "a share names a claim that is not under review on this prospect", { reason: "CLAIM_NOT_REVIEWABLE" });
            }
            beneficiaries.set(shareClaim.claimId, shareClaim);
          }
          // judged again after the last lock taken before the writes (the share claims): a deadline crossed while this unit waited refuses it;
          // the database judges every acceptance once more at COMMIT (0045 attribution_claims_accepted_in_window, KC021)
          await refuseLapsed(claim, true);
          const competing = (await attribution.claimsOfProspect(claim.prospectId)).filter((c) => !beneficiaries.has(c.claimId) && REVIEWABLE.has(c.state));
          await attribution.freezeAllocation(allocation.allocationId, now);
          let accepted: AttributionClaimRecord = claim;
          for (const shareClaim of beneficiaries.values()) {
            const next = applied(await attribution.transitionClaim(shareClaim.claimId, shareClaim.version, { state: "ACCEPTED", agencyId: allocation.agencyId, allocationId: allocation.allocationId }, now));
            if (next.claimId === claim.claimId) accepted = next;
          }
          for (const loser of competing) {
            const locked = (await attribution.lockClaim(loser.claimId)) ?? loser;
            applied(await attribution.transitionClaim(loser.claimId, locked.version, { state: "REJECTED", agencyId: allocation.agencyId, allocationId: allocation.allocationId }, now));
          }
          return {
            status: 200,
            view: {
              claim: claimView(accepted),
              allocationId: allocation.allocationId,
              agencyId: allocation.agencyId,
              decisionReason: claim.state === "DISPUTED" ? DECISION_REASONS.CONFLICT_RESOLVED : beneficiaries.size > 1 ? DECISION_REASONS.AGREED_SPLIT : competing.length > 0 ? DECISION_REASONS.COMPETITORS_REJECTED : DECISION_REASONS.SOLE_CLAIM,
              beneficiaryCount: beneficiaries.size,
              rejectedClaimCount: competing.length,
            },
            version: accepted.version,
            resourceKind: "attribution_claim",
            resourceId: accepted.claimId,
          };
        },
      });
    },
  };
}

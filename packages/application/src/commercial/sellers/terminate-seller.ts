/**
 * CMD050 TerminateSeller — POST /api/v1/sales/sellers/{sellerId}/terminate — KAURO_OWNER — scope CORPORATE — no provider effect (design §5,
 * §10, §12; decision D10-TERM-1; registry "end new assignment/access, preserve signed residuals and define the eligible ninety-day
 * opportunity tail"; R2-100; 17 "Termination and tail").
 *
 * One unit of work of the owner's OPERATOR context, in B06's pipeline order: access (CommercialAuthorizer: the caller's own ACTIVE
 * KAURO_OWNER grant) → journal reserve (or the replay of the journaled 200) → the body, the first failure answering: the seller FOR UPDATE
 * with the exclusive half of kauro.sellers (NOT_FOUND) → expectedVersion (STALE_VERSION with the current version and state) → ACTIVE or
 * SUSPENDED (UNLISTED_TRANSITION) → the owner's prepared termination terms of this seller, not yet effective
 * (TERMINATION_TERMS_UNPREPARED) → the prepared manifest of this seller, each entry one of its ACCEPTED, unexpired claims
 * (TAIL_NOT_ENUMERATED; the database repeats it and adds the agency without a qualifying purchase, KC011).
 * Writes, in the order the database's guards need them: the termination effective at the server's instant with one tail entry per listed
 * opportunity ending 2160 hours (exact hours) later; the seller TERMINATED at that instant; every other live claim of the seller EXPIRED
 * (a listed one stays ACCEPTED for its tail); each ACTIVE or DISPUTED entitlement TERMINATED_WITH_RESIDUAL (its window, share and agreement
 * never change); the prospects the seller owns unassigned; each current assignment of the seller ended by a SELLER_TERMINATED link.
 * Nothing of the ledger is touched, deleted or forfeited: lines, adjustments, statements, payout rows and the seller's agreements stay.
 * A corporate aggregate publishes no event (D10-EVT-1). The race against AcceptAttribution is B10-INTEGRATION's.
 */
import type { UtcInstant } from "@kauro/contracts";
import { toUtcInstant } from "@kauro/domain";
import type { AttributionClaimRecord, CausationId, SellerId, TerminationManifestRef, TerminationTailEntryRecord, TerminationTermsRef } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { applied, checkExpectedVersion } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { TERMINATE_SELLER, type TerminateSellerBody } from "../contracts.js";
import type { SellerTerminationView } from "../views.js";
import type { SellerCommandCollaborators } from "./runtime.js";

/** The tail of an enumerated opportunity: ninety days of 24 exact hours (policy terminationOpportunityTailDays; KC011's interval). */
export const TERMINATION_TAIL_HOURS = 2160;
const HOUR_MS = 3_600_000;

/** The states a seller may be terminated from (§8.2 Seller: ACTIVE and SUSPENDED; a CANDIDATE is not engaged and has no tail to define). */
const TERMINABLE: ReadonlySet<string> = new Set(["ACTIVE", "SUSPENDED"]);
/** The claims that are still live: they lapse with their seller unless handed over. */
const LIVE_CLAIM: ReadonlySet<string> = new Set(["SUBMITTED", "DISPUTED", "ACCEPTED"]);

const unenumerated = (what: string): DomainFailure => new DomainFailure("PRECONDITION_FAILED", `the opportunity manifest is not enumerable: ${what}`, { reason: "TAIL_NOT_ENUMERATED" });

export function terminateSellerHandler(runtime: CommerceRequestRuntime, co: SellerCommandCollaborators): CommercialCommandHandler<TerminateSellerBody, SellerTerminationView> {
  const spec = TERMINATE_SELLER;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<TerminateSellerBody>): Promise<CommandResult<SellerTerminationView>> {
      const context = operatorContextOf(envelope);
      const sellerId = envelope.path["sellerId"] as SellerId;
      return runCommerceCommand<TerminateSellerBody, SellerTerminationView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD050", decision);
        },
        async body(uow, _causationId: CausationId, now: UtcInstant) {
          const body = envelope.body;
          const sales = co.sales(uow);
          const attribution = co.attribution(uow);
          const seller = await sales.lockSeller(sellerId);
          if (seller === null) throw new NotFoundFailure("seller");
          checkExpectedVersion(seller, body.expectedVersion);
          if (!TERMINABLE.has(seller.state)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the seller is not ACTIVE or SUSPENDED: a termination is requested from those states only", { reason: "UNLISTED_TRANSITION", currentVersion: seller.version, currentState: seller.state });
          }
          const terms = await sales.getTerminationTerms(body.terminationTermsRef as TerminationTermsRef);
          if (terms === null || terms.sellerId !== sellerId || terms.effectiveAt !== undefined) {
            throw new DomainFailure("PRECONDITION_FAILED", "no termination terms prepared for this seller are waiting to take effect", { reason: "TERMINATION_TERMS_UNPREPARED" });
          }
          const manifest = await sales.getTerminationManifest(body.activeOpportunityManifestRef as TerminationManifestRef);
          if (manifest === null || manifest.sellerId !== sellerId) throw unenumerated("no manifest prepared for this seller");
          // each listed entry is one of the seller's own ACCEPTED claims whose acceptance has not run out; the agency's purchase history is the database's (KC011)
          const open = await attribution.openClaimsOf(sellerId);
          const openById = new Map<string, AttributionClaimRecord>(open.map((c) => [c.claimId as string, c]));
          const listed: AttributionClaimRecord[] = [];
          for (const claimId of manifest.claimIds) {
            const claim = openById.get(claimId as string);
            if (claim === undefined || claim.state !== "ACCEPTED" || claim.agencyId === undefined || claim.expiresAt <= now) {
              throw unenumerated("an entry is not an accepted, unexpired claim of this seller");
            }
            listed.push(claim);
          }
          // the termination takes effect at the server's instant; the tail entries end 2160 exact hours after it
          const effectiveAt = now;
          const tailEntries: TerminationTailEntryRecord[] = listed.map((claim) => ({
            terminationId: terms.terminationId,
            claimId: claim.claimId,
            sellerId,
            agencyId: claim.agencyId!,
            effectiveAt,
            endsAt: toUtcInstant(Date.parse(effectiveAt) + TERMINATION_TAIL_HOURS * HOUR_MS),
          }));
          const recorded = applied(await sales.recordTermination({ terminationId: terms.terminationId, expectedVersion: terms.version, manifestRef: manifest.manifestRef, effectiveAt, tailEntries }));
          const effective = recorded.effectiveAt ?? effectiveAt;
          const terminated = applied(await sales.transitionSeller(sellerId, seller.version, { state: "TERMINATED" }, now));
          // every live claim the seller did not hand over lapses with it, locked in id order after its prospect's transition half
          const handedOver = new Set(manifest.claimIds.map((id) => id as string));
          let claimsExpired = 0;
          for (const claim of open.filter((c) => !handedOver.has(c.claimId as string)).sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0))) {
            const current = await attribution.lockClaim(claim.claimId);
            if (current === null || !LIVE_CLAIM.has(current.state)) continue;
            // a claim whose agency's first purchase was confirmed before its end has accrued its rights: a termination alone does not cancel
            // them (registry 17), so it is left ACCEPTED for the commission service's conversion, a moment behind the capture (D10-GAP-19)
            if (current.state === "ACCEPTED" && (await attribution.convertibleAtFirstPurchase(current.claimId))) continue;
            applied(await attribution.transitionClaim(current.claimId, current.version, { state: "EXPIRED" }, now));
            claimsExpired += 1;
          }
          // the entitlements keep their window, share and agreement; the lines they accrue stay the seller's residual
          let entitlementsResidual = 0;
          for (const entitlement of await attribution.entitlementsOfSeller(sellerId)) {
            if (entitlement.state !== "ACTIVE" && entitlement.state !== "DISPUTED") continue;
            applied(await attribution.transitionEntitlement(entitlement.entitlementId, entitlement.version, "TERMINATED_WITH_RESIDUAL", now));
            entitlementsResidual += 1;
          }
          const prospectsUnassigned = await sales.unassignProspects(sellerId, now);
          const assignmentsEnded = (await sales.endAssignmentsOf(sellerId, now)).length;
          return {
            status: 200,
            view: {
              sellerId,
              version: terminated.version,
              state: terminated.state,
              effectiveAt: effective,
              tailEndsAt: toUtcInstant(Date.parse(effective) + TERMINATION_TAIL_HOURS * HOUR_MS),
              tailEntries: tailEntries.length,
              entitlementsResidual,
              claimsExpired,
              prospectsUnassigned,
              assignmentsEnded,
            },
            version: terminated.version,
            resourceKind: "seller",
            resourceId: sellerId,
          };
        },
      });
    },
  };
}

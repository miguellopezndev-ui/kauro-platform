/** The claim view both CMD046 and CMD047 answer: the claim as its seller and the owner read it, never its evidence beyond the hash. */
import type { AttributionClaimRecord } from "@kauro/domain";
import type { AttributionClaimView } from "../views.js";

export function claimView(claim: AttributionClaimRecord): AttributionClaimView {
  return {
    claimId: claim.claimId,
    prospectId: claim.prospectId,
    sellerId: claim.sellerId,
    ...(claim.acceptedAt !== undefined ? { acceptedAt: claim.acceptedAt } : {}),
    expiresAt: claim.expiresAt,
    evidenceHash: claim.evidenceHash,
    state: claim.state,
    agreementVersion: claim.agreementVersion,
    version: claim.version,
  };
}

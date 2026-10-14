/**
 * The two shipped bindings of package B10 that need no database (design §11; D10-BIND-1): until B11 records a buyer type and B15
 * verifies payout evidence, the shipped edition answers exactly the refusal the design names, so nothing is ever concluded from an
 * integration that does not exist. Neither is a fake: they carry no simulated label because they simulate nothing — they say "not
 * recorded" and "not available". The two bindings that read B10's own tables (the recorded banking calendar and the authorization
 * delivery completions) are adapters of B10-ADAPTERS-LEDGER.
 */
import type { AgencyId, IntegrationClass, UnitOfWork } from "@kauro/domain";
import type { BuyerType, BuyerTypeReader, PayoutEvidenceAnswer, PayoutEvidenceVerifier, ProviderCallTimer } from "./ports.js";
import type { PlatformBinding } from "../commerce/ports.js";

/** The refusal reason CMD053 answers PRECONDITION_FAILED while no payout evidence can be verified. */
export const PAYOUT_EVIDENCE_UNAVAILABLE = "PAYOUT_EVIDENCE_UNAVAILABLE" as const;

/**
 * Always unset: the shipped edition records no buyer type, so CMD027 refuses every quote BUYER_TYPE_UNSET and CMD047 refuses every
 * attribution (an agency of unset type earns nobody a commission). B11's W6 `agency_buyer_types` replaces this binding at integration.
 */
export class UnrecordedBuyerTypeReader implements BuyerTypeReader {
  readonly binding: PlatformBinding = "PLATFORM";

  async buyerTypeOf(_uow: UnitOfWork, _request: { readonly agencyId: AgencyId }): Promise<BuyerType | null> {
    return null;
  }
}

/** The provider-call bound of a deployment: the runtime's own timer. */
export const realProviderCallTimer: ProviderCallTimer = {
  start(ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // expired: the bound timer itself has fired (no process clock is read here: the four injection points stay the only ones, CK3)
    let fired = false;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        fired = true;
        resolve();
      }, ms);
    });
    return { elapsed, cancel: () => clearTimeout(timer), expired: () => fired };
  },
};

/** Never verifies: CMD053 is refused PAYOUT_EVIDENCE_UNAVAILABLE and no payout is reconciled from a claim nobody authenticated. B15 replaces it. */
export class UnavailablePayoutEvidenceVerifier implements PayoutEvidenceVerifier {
  readonly integrationClass: IntegrationClass = "PROVIDER";

  async verify(_request: { readonly evidenceRef: string }): Promise<PayoutEvidenceAnswer> {
    return { kind: "UNAVAILABLE", reason: PAYOUT_EVIDENCE_UNAVAILABLE };
  }
}

/**
 * FoundingOfferReader over `pg` (@kauro/application commercial ports; design §3.3; R2-091): the reservable slots of the current founding
 * cohort, in any unit of work of this package — an anonymous request's included: the slot rows are readable platform rows. It
 * reserves nothing and carries no agency, quote or reservation. The current cohort is the price policy the registry names unless the
 * composition binds another version.
 */
import type { UtcInstant } from "@kauro/contracts";
import { registryPricePolicy, type FoundingOfferView, type UnitOfWork } from "@kauro/domain";
import { foundingOf } from "../commercial-unit-of-work.js";

export interface FoundingOffer extends FoundingOfferView {
  readonly asOf: UtcInstant;
}

export class PgFoundingOfferReader {
  readonly binding = "PLATFORM" as const;
  readonly #policyVersion: string;

  constructor(policyVersion: string = registryPricePolicy().version) {
    this.#policyVersion = policyVersion;
  }

  async currentOffer(uow: UnitOfWork, request: { readonly at: UtcInstant }): Promise<FoundingOffer | null> {
    const view = await foundingOf(uow).offer(this.#policyVersion);
    return view.slots === 0 ? null : { ...view, asOf: request.at };
  }
}

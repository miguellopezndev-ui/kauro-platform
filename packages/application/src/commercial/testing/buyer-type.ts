/**
 * The contract fake of BuyerTypeReader (design §11, D10-FAKE-1): the platform port B11 will answer from its recorded buyer type.
 * It answers only what a test scripted per agency — AGENCY, IN_HOUSE, or nothing (null), which CMD027 refuses BUYER_TYPE_UNSET.
 * `binding: CONTRACT_FAKE`, evidence class SIMULATED, a call log and a hold point; reachable only from the testing subpath.
 */
import type { Clock, AgencyId, UnitOfWork } from "@kauro/domain";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, type FakeCall } from "../../commerce/testing/labels.js";
import type { BuyerType, BuyerTypeReader } from "../ports.js";
import { HoldPoints, type CommercialFakeHold } from "./holds.js";

export const BUYER_TYPE_FAKE_PROVIDER = "contract-fake-buyer-type" as const;

export class ContractFakeBuyerTypeReader implements BuyerTypeReader {
  readonly provider = BUYER_TYPE_FAKE_PROVIDER;
  readonly integrationClass = CONTRACT_FAKE;
  readonly evidenceClass = FAKE_EVIDENCE_CLASS;
  readonly contractFake = true as const;
  readonly binding = CONTRACT_FAKE;

  private readonly recorded = new Map<string, BuyerType>();
  private readonly log: FakeCall[] = [];
  private readonly holds = new HoldPoints<"BUYER_TYPE_OF">();

  constructor(private readonly options: { readonly clock: Clock }) {}

  /** The calls received so far, oldest first; a frozen copy. */
  get calls(): ReadonlyArray<FakeCall> {
    return Object.freeze([...this.log]);
  }

  /** Scripts the agency's buyer type; null returns it to unset. */
  set(agencyId: AgencyId, buyerType: BuyerType | null): void {
    if (buyerType === null) this.recorded.delete(agencyId);
    else this.recorded.set(agencyId, buyerType);
  }

  /** Stops the next `buyerTypeOf` after it was recorded, until the test releases it. */
  hold(operation: "BUYER_TYPE_OF"): CommercialFakeHold {
    return this.holds.hold(operation);
  }

  async buyerTypeOf(uow: UnitOfWork, request: { readonly agencyId: AgencyId }): Promise<BuyerType | null> {
    this.log.push(Object.freeze({ port: "BuyerTypeReader", operation: `BUYER_TYPE_OF ${uow.context.kind}`, identity: request.agencyId, at: this.options.clock.now(), sent: true }));
    await this.holds.arrive("BUYER_TYPE_OF");
    return this.recorded.get(request.agencyId) ?? null;
  }
}

/**
 * The COMMISSIONS consumer (docs/design/B10-commercial-domain.md §14; mandate B10-COMMISSION-SERVICE).
 */
import type { CommerceEventDelivery } from "@kauro/application";
import { DomainFailure } from "@kauro/domain";
import type { ConsumerOutcome } from "../payments/index.js";
import type { CommissionRuntime } from "./runtime.js";

export interface CommissionsConsumer {
  readonly consumer: "COMMISSIONS";
  readonly eventTypes: ReadonlyArray<string>;
  handle(delivery: CommerceEventDelivery): Promise<ConsumerOutcome>;
}

export function commissionsConsumer(_rt: CommissionRuntime): CommissionsConsumer {
  return {
    consumer: "COMMISSIONS",
    eventTypes: [],
    async handle() {
      throw new DomainFailure("INTEGRITY_FAILURE", "the COMMISSIONS consumer is not built");
    },
  };
}

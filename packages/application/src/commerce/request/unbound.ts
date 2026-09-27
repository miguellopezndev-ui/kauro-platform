/**
 * The handler shapes of the B09 routes the api registers, and what stands for a provider adapter or a payment service this
 * deployment does not bind (D-REQ-B1): every use of either is INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE, so a deployment
 * before the integration package (B15) answers the provider-effect commands inside their unit of work with nothing written, and a
 * journal entry left pending by an earlier deployment is answered, never dispatched.
 */
import type { CommerceUnitOfWorkFactory, PaymentEnvironment } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import type { ReadRequest, ReadResult, ReadSpec } from "../../queries/reads.js";
import type { CommandSpec } from "../../ports/command-handler.js";
import type { CommerceCommandSpec } from "../contracts.js";
import type { PaymentProviderAdapter } from "../ports.js";
import { providerServicesUnavailable, type CommerceReadSpec } from "./runtime.js";

/** A served B09 command: its catalogue spec, the spec the transport's admission reads, and its execution. */
export interface CommerceCommandHandler<Body, View> {
  readonly spec: CommerceCommandSpec<Body>;
  readonly admission: CommandSpec<Body>;
  execute(envelope: CommandEnvelope<Body>): Promise<CommandResult<View>>;
}

/** A served B09 read: its route, the spec the transport's admission reads, and its execution. */
export interface CommerceReadHandler<View> {
  readonly spec: CommerceReadSpec;
  readonly admission: ReadSpec<string>;
  execute(request: ReadRequest): Promise<ReadResult<View>>;
}

/** The provider adapter of a deployment that binds none: every use is PROVIDER_SERVICES_UNAVAILABLE. */
export function unboundProvider(): PaymentProviderAdapter {
  const refuse = (): never => {
    throw providerServicesUnavailable();
  };
  return {
    provider: "unbound",
    environment: "SANDBOX" as PaymentEnvironment,
    integrationClass: "PROVIDER",
    approvalHosts: [],
    prepareCreateOrder: refuse,
    prepareCapture: refuse,
    prepareRefund: refuse,
    dispatch: async () => refuse(),
    observeOrder: async () => refuse(),
    observeRefund: async () => refuse(),
    classifyOrderObservation: refuse,
  };
}

/** The payment service's units of work of a deployment that binds none: every settle step is PROVIDER_SERVICES_UNAVAILABLE. */
export function unboundPaymentService(): CommerceUnitOfWorkFactory {
  return {
    async run() {
      throw providerServicesUnavailable();
    },
  };
}

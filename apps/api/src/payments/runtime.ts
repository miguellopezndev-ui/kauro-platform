/**
 * What every part of the payment service shares (docs/design/B09-payments-fiscal.md §8.2; stage-2 mandate M3): the assembly of
 * pools and ports, the deployment environment, the clock and ids, M2's reconciler bound to the column-scoped purchased-subject
 * read (D-CORE-B2), M2's commerce authorizer, the verifiers by provider, the payment service's own verified identity for the work
 * it starts itself (the refund executor, the watchdog, the inbox worker), and the sink of background failures.
 */
import type { CommerceAuthorizer, CommerceReconciler, WebhookVerifier } from "@kauro/application";
import { createCommerceAuthorizer, createCommerceReconciler } from "@kauro/application";
import { createAssuranceVerifier } from "@kauro/authorization";
import type { CausationId, Clock, CommerceUnitOfWork, Environment, IdGenerator, ServiceIdentity } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { PgCommerceUnitOfWork } from "@kauro/persistence";
import { purchasedSubjectReader } from "../edition.js";
import type { PaymentServiceAssembly } from "./assembly.js";

/** The payment service's own identity (SERVICE_ROLE_TABLE: payment-service → PAYMENT_SERVICE; D-AUTHZ-B3). */
export const PAYMENT_SERVICE_ID = "payment-service";
/** The audience of the api's service routes (10 "Internal command authentication"). */
export const SERVICE_AUDIENCE = "kauro-api";
/** The provider ingress's identity in its own security facts (SERVICE_ROLE_TABLE: provider-ingress → AUTHENTICATED_PROVIDER). */
export const PROVIDER_INGRESS_ID = "provider-ingress";

export interface PaymentRuntime {
  readonly assembly: PaymentServiceAssembly;
  /** The deployment environment the service identities must have been issued for, and the journal's environment. */
  readonly environment: Environment;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly reconciler: CommerceReconciler;
  readonly authorizer: CommerceAuthorizer;
  readonly verifiers: ReadonlyMap<string, WebhookVerifier>;
  /** The payment service's own verified identity (work it starts itself; never a caller's). */
  readonly self: ServiceIdentity;
  /** Receives a failure of work no request waits for (an application the inbox worker retries, a consumer effect) by correlation id. */
  readonly onBackgroundFailure: (correlationId: string, error: unknown) => void;
}

export function createPaymentRuntime(input: {
  readonly assembly: PaymentServiceAssembly;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly onBackgroundFailure: (correlationId: string, error: unknown) => void;
}): PaymentRuntime {
  const verifiers = new Map<string, WebhookVerifier>();
  for (const v of input.assembly.verifiers) {
    if (verifiers.has(v.provider)) throw new DomainFailure("INTEGRITY_FAILURE", `two webhook verifiers for provider ${v.provider}`);
    verifiers.set(v.provider, v);
  }
  return {
    ...input,
    reconciler: createCommerceReconciler({ subjects: purchasedSubjectReader, approvalHosts: input.assembly.provider.approvalHosts }),
    authorizer: createCommerceAuthorizer({ clock: input.clock, assurance: createAssuranceVerifier() }),
    verifiers,
    self: { serviceId: PAYMENT_SERVICE_ID, audience: SERVICE_AUDIENCE, environment: input.environment },
  };
}

/**
 * Names the cause of the events a commerce unit of work publishes from here on (D-EVT-B4): the delivered event a consumer acts on,
 * the inbox record the reconciler applies, the stored operation a sweep settles. The `pg` unit of work carries it; another adapter
 * falls back to its own provenance.
 */
export function causedBy(uow: CommerceUnitOfWork, cause: string): void {
  if (uow instanceof PgCommerceUnitOfWork) uow.causedBy(cause as CausationId);
}

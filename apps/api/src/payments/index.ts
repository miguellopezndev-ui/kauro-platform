/**
 * The payment service's side of package B09 in the api (docs/design/B09-payments-fiscal.md §8.2, §14 M3): the service composition
 * (assembly.ts), the webhook (CMD030, webhook.ts), the service commands (CMD033, CMD034, service-commands.ts), the consumers
 * FINANCE, FISCAL and PAYMENT_SERVICE (consumers.ts) run by the payment dispatcher (dispatcher.ts), the inbox worker, the periodic
 * pass (sweep.ts), the re-binder (rebinder.ts) and the routes (routes.ts). `createPaymentService` binds them over one assembly.
 */
import type { CommandResult, ExecuteRefundBody, ExecuteRefundView, PurchaseRebinder, ReconcilePaymentBody, ReconcilePaymentView, SchemaValidator } from "@kauro/application";
import type { AgencyId, Clock, Environment, IdGenerator } from "@kauro/domain";
import type { PaymentServiceAssembly } from "./assembly.js";
import { fiscalConsumer, financeConsumer, paymentServiceEffect, unitOfWorkEffect, type DeliveryEffect } from "./consumers.js";
import { createPaymentDispatcher, type PaymentDispatcher } from "./dispatcher.js";
import { sourceLineageReader } from "../edition.js";
import { createPurchaseRebinder } from "./rebinder.js";
import { createPaymentRuntime, type PaymentRuntime } from "./runtime.js";
import { executeRefund, reconcilePayment, type ServiceCommandRequest } from "./service-commands.js";
import { runSweepPass, type SweepPass } from "./sweep.js";
import { receiveWebhook, runInboxPass, type InboxPass, type WebhookOutcome, type WebhookRequest } from "./webhook.js";

export interface PaymentService {
  readonly runtime: PaymentRuntime;
  executeRefund(request: ServiceCommandRequest<ExecuteRefundBody>): Promise<CommandResult<ExecuteRefundView>>;
  reconcilePayment(request: ServiceCommandRequest<ReconcilePaymentBody>): Promise<CommandResult<ReconcilePaymentView>>;
  receiveWebhook(validator: SchemaValidator, request: WebhookRequest): Promise<WebhookOutcome>;
  /** One bounded pass of the inbox worker (D-ING-B1). */
  runInboxPass(options?: { readonly limit?: number; readonly staleClaimSeconds?: number }): Promise<InboxPass>;
  /** One bounded periodic pass: unclaimed intents cancelled, overdue attempts reconciled (D-PROTO-B4). */
  runSweepPass(options?: { readonly agencies?: number; readonly limit?: number; readonly after?: AgencyId }): Promise<SweepPass>;
  /** The dispatcher of FINANCE, FISCAL and PAYMENT_SERVICE (D-CONS-B1). */
  readonly dispatcher: PaymentDispatcher;
  readonly effects: ReadonlyArray<DeliveryEffect>;
  /** D-QUOTE-B6, for the recurrence package's replacement flow (B10). */
  readonly rebinder: PurchaseRebinder;
}

export function createPaymentService(input: {
  readonly assembly: PaymentServiceAssembly;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Receives a failure of work no request waits for, by correlation id; default: one stderr line with the safe classification. */
  readonly onBackgroundFailure?: (correlationId: string, error: unknown) => void;
}): PaymentService {
  const runtime = createPaymentRuntime({
    assembly: input.assembly,
    environment: input.environment,
    clock: input.clock,
    ids: input.ids,
    onBackgroundFailure: input.onBackgroundFailure ?? ((correlationId, error) => process.stderr.write(`kauro-api payment background failure correlation=${correlationId} class=${error instanceof Error ? error.name : typeof error}\n`)),
  });
  const effects: ReadonlyArray<DeliveryEffect> = [unitOfWorkEffect(runtime, financeConsumer()), unitOfWorkEffect(runtime, fiscalConsumer()), paymentServiceEffect(runtime)];
  return {
    runtime,
    executeRefund: (request) => executeRefund(runtime, request),
    reconcilePayment: (request) => reconcilePayment(runtime, request),
    receiveWebhook: (validator, request) => receiveWebhook(runtime, validator, request),
    runInboxPass: (options) => runInboxPass(runtime, options),
    runSweepPass: (options) => runSweepPass(runtime, options),
    dispatcher: createPaymentDispatcher(runtime, effects),
    effects,
    rebinder: createPurchaseRebinder({ lineage: sourceLineageReader }),
  };
}

export { openPaymentPools, PAYMENT_APPLICATION_NAME } from "./assembly.js";
export type { PaymentServiceAssembly, PaymentServiceAdapters, PaymentDatabases, PaymentPools, PaymentHold, PaymentHoldCommand, PaymentHoldPoint } from "./assembly.js";
export { PAYMENT_SERVICE_ID, PROVIDER_INGRESS_ID, SERVICE_AUDIENCE } from "./runtime.js";
export type { PaymentRuntime } from "./runtime.js";
export { NotDueYet, recordServiceDenial, storeProviderQuery, watchAttempt } from "./service-commands.js";
export type { ServiceCommandRequest } from "./service-commands.js";
export { AWAIT_INVOICE_SECONDS, eventTypesOf, financeConsumer, fiscalConsumer, paymentServiceEffect, recordedAtOf, reevaluateBlockedDrafts, refundExecutionKey, unitOfWorkEffect } from "./consumers.js";
export type { ConsumerOutcome, DeliveryEffect, PaymentConsumerName } from "./consumers.js";
export { DISPATCH_LEASE_DEADLINE, DISPATCH_LEASE_SECONDS, MAX_DELIVERY_ATTEMPTS, OUTBOX_CLAIM_SECONDS, createPaymentDispatcher, leaseResourceOf } from "./dispatcher.js";
export type { DispatchPass, PaymentDispatcher } from "./dispatcher.js";
export { CLAIM_NEVER_COMMITTED, CLAIM_WINDOW_SECONDS, cancelUnclaimed } from "./sweep.js";
export type { SweepPass } from "./sweep.js";
export { applyInboxRecord, settleConflict } from "./webhook.js";
export type { InboxPass, WebhookOutcome, WebhookRequest } from "./webhook.js";
export { createPurchaseRebinder } from "./rebinder.js";

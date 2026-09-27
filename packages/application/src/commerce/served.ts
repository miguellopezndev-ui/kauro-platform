/**
 * The B09 operations the api serves, and the reply contract of each served route (design §10, D-API-B1; decisions D-REQ-B7 and
 * D-INT2-B1 of docs/design/B09-payments-fiscal.md). A designed operation is documented under `x-kauro-planned` of the OpenAPI document
 * until a route serves it; once served it moves here, and from here into the route inventory, the api's send guard, the OpenAPI
 * `paths` and the matrix's served sections — exactly as the B06 routes (COMMAND_RESPONSES, READ_RESPONSES).
 *
 * Every one of the seven commands is served: the request side (implementation mandate M4) serves CreatePaymentOrder (CMD028),
 * CapturePayment (CMD029), RequestRefund (CMD031), ApproveRefund (CMD032) and the four reads; the payment service's side (M3) serves
 * the provider webhook (CMD030), ExecuteRefund (CMD033) and ReconcilePayment (CMD034). The stage-2 integration keeps one list.
 *
 * A route's contract: its COMPLETED status with the command's envelope, the ACCEPTED envelope (202) where a provider effect can be
 * unknown or in flight (D-PROTO-B2), and the Problem document of its closed outcome catalogue (COMMERCE_COMMAND_OUTCOMES,
 * COMMERCE_READ_OUTCOMES) for every other status.
 */
import type { CommerceEventType } from "@kauro/domain";
import { HEADERS } from "../api/envelope.js";
import { PROBLEM_RESPONSE, type DeclaredResponse, type RouteResponses } from "../api/response-contract.js";
import { ACCEPTED_RESPONSE_SCHEMA_ID } from "../api/response-schemas.js";
import type { KnownSchemaId } from "../ports/schema-validator.js";
import { COMMERCE_COMMANDS } from "./contracts.js";
import { COMMERCE_COMMAND_OUTCOMES, COMMERCE_READ_OUTCOMES } from "./outcomes.js";
import { COMMERCE_COMMAND_RESPONSES, commerceCommandResponseSchemaId, commerceReadResponseSchemaId, type CommerceReadOperationId, type CommerceServedCommandId } from "./response-schemas.js";

/** The B09 commands the api serves: the request side (M4) and the payment service's side (M3). */
export const COMMERCE_SERVED_COMMAND_IDS = Object.freeze(["CMD028", "CMD029", "CMD030", "CMD031", "CMD032", "CMD033", "CMD034"] as const satisfies ReadonlyArray<CommerceServedCommandId>);
export type CommerceServedRouteCommandId = (typeof COMMERCE_SERVED_COMMAND_IDS)[number];

/** The B09 reads the api serves (M4). */
export const COMMERCE_SERVED_READ_IDS = Object.freeze(["GetQuote", "GetPaymentOrder", "GetRefund", "GetRefundReview"] as const satisfies ReadonlyArray<CommerceReadOperationId>);

export function isServedCommerceCommand(id: string): id is CommerceServedRouteCommandId {
  return (COMMERCE_SERVED_COMMAND_IDS as ReadonlyArray<string>).includes(id);
}

export function isServedCommerceRead(id: string): id is CommerceReadOperationId {
  return (COMMERCE_SERVED_READ_IDS as ReadonlyArray<string>).includes(id);
}

/**
 * The declared replies of a served B09 command route (its `config.responses`): its COMPLETED status (and 202 ACCEPTED for a provider
 * effect), problems otherwise. The operationId is the catalogue's name of the command (COMMERCE_COMMANDS).
 */
export function commerceCommandRouteResponses(command: CommerceServedCommandId): RouteResponses {
  if (!isServedCommerceCommand(command)) throw new TypeError(`${command} is not a served payment command (COMMERCE_SERVED_COMMAND_IDS)`);
  const reply = COMMERCE_COMMAND_RESPONSES[command];
  const declared: Record<string, DeclaredResponse> = {
    [String(reply.status)]: Object.freeze({ contentType: HEADERS.contentType, schemaId: commerceCommandResponseSchemaId(command) as KnownSchemaId }),
  };
  if (reply.accepted) declared["202"] = Object.freeze({ contentType: HEADERS.contentType, schemaId: ACCEPTED_RESPONSE_SCHEMA_ID });
  return Object.freeze({ operationId: COMMERCE_COMMANDS[command].name, declared: Object.freeze(declared), problem: PROBLEM_RESPONSE, outcomes: COMMERCE_COMMAND_OUTCOMES[command] });
}

/** The declared replies of a served B09 read: 200 with its READ envelope, problems from its catalogue otherwise. */
export function commerceReadRouteResponses(operationId: CommerceReadOperationId): RouteResponses {
  return Object.freeze({
    operationId,
    declared: Object.freeze({ "200": Object.freeze({ contentType: HEADERS.contentType, schemaId: commerceReadResponseSchemaId(operationId) as KnownSchemaId }) }),
    problem: PROBLEM_RESPONSE,
    outcomes: COMMERCE_READ_OUTCOMES[operationId],
  });
}

/**
 * The event types the reconciler's settle step publishes (the payment service's side: the webhook's application, the stored query's
 * application, and the settle step of a dispatched provider command). Every version the reconciler writes is published with the type
 * commerceVersionEventType names (D-EVT-B3, D-CORE-B1), so the list is the types of the versions its planners write (decision
 * D-M3-B9).
 */
const RECONCILER_EVENTS: ReadonlyArray<CommerceEventType> = Object.freeze([
  "payment_order.created.v1",
  "payment_order.approved.v1",
  "payment_order.capture_uncertain.v1",
  "payment_order.captured.v1",
  "payment_order.failed.v1",
  "payment_order.cancelled.v1",
  "payment_order.expired.v1",
  "payment_attempt.provider_pending.v1",
  "payment_attempt.confirmed.v1",
  "payment_attempt.failed_no_effect.v1",
  "payment_attempt.uncertain.v1",
  "capture.pending.v1",
  "capture.completed.v1",
  "capture.denied.v1",
  "capture.reversed.v1",
  "capture.fee_observed.v1",
  "capture.funds_observed.v1",
  "commercial_authorization.issued.v1",
  "commercial_authorization.revoked.v1",
  "refund.requested.v1",
  "refund.approved.v1",
  "refund.uncertain.v1",
  "refund.completed.v1",
  "refund.failed.v1",
  "reconciliation_case.opened.v1",
] satisfies ReadonlyArray<CommerceEventType>);

/**
 * The event types the units of work of each served B09 command may publish (the matrix's "events published" and its edge-owner
 * check; D-REQ-B7, D-M3-B9, D-INT2-B1): the request handlers' intent and claim (T1, T2) and the payment service's settle step
 * through the reconciler (T3), whose planner publishes each version's event (commerceVersionEventType). Every route test of a served
 * command proves each event a run publishes is listed here for its command.
 */
export const COMMERCE_COMMAND_EVENTS: Readonly<Record<CommerceServedRouteCommandId, ReadonlyArray<CommerceEventType>>> = Object.freeze({
  // T1 intent, T2 claim; T3 applies the provider's creation (or its proved no-effect, its ambiguity, an unrecognized answer)
  CMD028: [
    "quote.accepted_for_checkout.v1",
    "payment_order.intent_created.v1",
    "payment_attempt.prepared.v1",
    "payment_attempt.dispatching.v1",
    "payment_order.creating.v1",
    "payment_order.created.v1",
    "payment_order.failed.v1",
    "payment_attempt.confirmed.v1",
    "payment_attempt.failed_no_effect.v1",
    "payment_attempt.uncertain.v1",
    "reconciliation_case.opened.v1",
  ],
  // T1 intent, T2 claim; T3 records the capture fact, the order's edge and — when the capture alone pays and the subject binds —
  // the CommercialAuthorization, or the cases and server refund requests that replace it
  CMD029: [
    "payment_attempt.prepared.v1",
    "payment_attempt.dispatching.v1",
    "payment_order.capturing.v1",
    "payment_order.captured.v1",
    "payment_order.capture_uncertain.v1",
    "payment_order.approved.v1",
    "payment_order.created.v1",
    "payment_attempt.confirmed.v1",
    "payment_attempt.provider_pending.v1",
    "payment_attempt.failed_no_effect.v1",
    "payment_attempt.uncertain.v1",
    "capture.pending.v1",
    "capture.completed.v1",
    "capture.denied.v1",
    "commercial_authorization.issued.v1",
    "refund.requested.v1",
    "reconciliation_case.opened.v1",
  ],
  // the verified provider event applied by the reconciler (the ingress itself writes the inbox record and no event)
  CMD030: RECONCILER_EVENTS,
  CMD031: ["refund.requested.v1"],
  CMD032: ["refund.approved.v1"],
  // its own intent and claim (the REFUND attempt PREPARED and DISPATCHING, the refund SUBMITTING), then the reconciler's settle step
  CMD033: [...RECONCILER_EVENTS, "payment_attempt.prepared.v1", "payment_attempt.dispatching.v1", "refund.submitting.v1"],
  // the stored, authenticated provider query applied by the reconciler
  CMD034: RECONCILER_EVENTS,
});

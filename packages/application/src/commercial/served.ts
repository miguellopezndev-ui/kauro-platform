/**
 * The B10 operations the api serves, and the reply contract of each served route (design §13; decision D10-API-1). A designed command
 * stays out of the api's route inventory, its OpenAPI `paths` and the matrix's served sections until its command lane serves it; once served
 * it is listed here, and from here the api's send guard, tools/openapi.mjs and the generated matrix cover it exactly as they cover the
 * B06 and B09 routes (COMMAND_RESPONSES, COMMERCE_SERVED_COMMAND_IDS). The command lanes of B10 each add their commands to
 * COMMERCIAL_SERVED_COMMAND_IDS (and the catalogue of commercial/outcomes and the events of COMMERCIAL_COMMAND_EVENTS) with their handler.
 *
 * B10-COMMANDS-PROSPECTS serves CMD045 RegisterProspect (201), CMD046 ClaimProspect (201) and CMD047 AcceptAttribution (200), each with its COMPLETED
 * envelope and a Problem of its closed catalogue otherwise.
 *
 * B10-COMMANDS-SELLERS serves CMD048 AssignAccount, CMD049 ActivateSeller and CMD050 TerminateSeller, each answering 200 with its view.
 * B10-COMMANDS-QUOTE serves CMD027 CreateQuote, answering 201 with its view.
 * B10-STATEMENTS-PAYOUTS serves CMD051 CloseCommissionPeriod and CMD053 ReconcileCommissionPayout (the commission group's service routes),
 * CMD052 ApproveCommissionPayout (the owner's) and the read GetCommissionStatement, each command answering 200 with its view.
 * B10-AGENCY-LIFECYCLE serves CMD002 ActivateAgency and CMD043 CloseAgency. Both answer 200 with their COMPLETED envelope (the agency is the
 * aggregate they edit) and a Problem of their closed catalogue otherwise; neither reaches a provider, so neither answers 202. CMD027 declares the 202 ACCEPTED envelope too: an included replacement whose
 * re-binding does not answer within its bound (D10-GAP-6a).
 */
import { HEADERS } from "../api/envelope.js";
import { PROBLEM_RESPONSE, type DeclaredResponse, type RouteResponses } from "../api/response-contract.js";
import { ACCEPTED_RESPONSE_SCHEMA_ID } from "../api/response-schemas.js";
import type { KnownSchemaId } from "../ports/schema-validator.js";
import { COMMERCIAL_COMMANDS } from "./contracts.js";
import { COMMERCIAL_COMMAND_OUTCOMES, COMMERCIAL_READ_OUTCOMES } from "./outcomes.js";
import { COMMERCIAL_COMMAND_RESPONSES, commercialCommandResponseSchemaId, commercialReadResponseSchemaId, type CommercialReadOperationId, type CommercialServedCommandId } from "./response-schemas.js";

/** The B10 commands the api serves. */
export const COMMERCIAL_SERVED_COMMAND_IDS = Object.freeze(["CMD002", "CMD027", "CMD043", "CMD045", "CMD046", "CMD047", "CMD048", "CMD049", "CMD050", "CMD051", "CMD052", "CMD053"] as const satisfies ReadonlyArray<CommercialServedCommandId>);
export type CommercialServedRouteCommandId = (typeof COMMERCIAL_SERVED_COMMAND_IDS)[number];

export function isServedCommercialCommand(id: string): id is CommercialServedRouteCommandId {
  return (COMMERCIAL_SERVED_COMMAND_IDS as ReadonlyArray<string>).includes(id);
}

/**
 * The declared replies of a served B10 command route (its `config.responses`): its COMPLETED status with the command's envelope, and
 * the Problem document of its closed outcome catalogue for every other status. The operationId is the catalogue's name of the command.
 */
export function commercialCommandRouteResponses(command: CommercialServedRouteCommandId): RouteResponses {
  if (!isServedCommercialCommand(command)) throw new TypeError(`${command} is not a served commercial command (COMMERCIAL_SERVED_COMMAND_IDS)`);
  const reply = COMMERCIAL_COMMAND_RESPONSES[command];
  const declared: Record<string, DeclaredResponse> = {
    [String(reply.status)]: Object.freeze({ contentType: HEADERS.contentType, schemaId: commercialCommandResponseSchemaId(command) as KnownSchemaId }),
  };
  if (reply.accepted) declared["202"] = Object.freeze({ contentType: HEADERS.contentType, schemaId: ACCEPTED_RESPONSE_SCHEMA_ID });
  return Object.freeze({ operationId: COMMERCIAL_COMMANDS[command].name, declared: Object.freeze(declared), problem: PROBLEM_RESPONSE, outcomes: COMMERCIAL_COMMAND_OUTCOMES[command] });
}

/**
 * The event types the unit of work of each served B10 command may publish (the matrix's "events published" and its edge-owner check): CMD002
 * the activation's own, CMD043 the closure's and the withdrawal of each open quote it closes over. Every route test of a served command proves
 * each event a run publishes is listed here for its command.
 */
export const COMMERCIAL_COMMAND_EVENTS: Readonly<Record<CommercialServedRouteCommandId, ReadonlyArray<string>>> = Object.freeze({
  CMD002: ["agency.activated.v1"],
  CMD043: ["agency.closing.v1", "quote.withdrawn.v1"],
  // the corporate machines (prospect, claim, allocation) publish no domain event (D10-EVT-2)
  CMD045: [],
  CMD046: [],
  CMD047: [],
  // a corporate aggregate publishes no event (D10-EVT-1): the seller commands' transitions are kept in commercial_transitions by the database
  CMD048: [],
  CMD049: [],
  CMD050: [],
  // CreateQuote: the quote's own versions, the superseded unpaid quote's, and — of an included replacement — the payment service's re-binding
  // and the withdrawal of a replacement it refused
  // the statement and payout commands: corporate aggregates publish no event (D10-EVT-1); their transitions are commercial_transitions
  CMD051: [],
  CMD052: [],
  CMD053: [],
  CMD027: [
    "quote.drafted.v1",
    "quote.issued.v1",
    "quote.superseded.v1",
    "quote.withdrawn.v1",
    "quote.accepted_for_checkout.v1",
    "commercial_authorization.revoked.v1",
    "commercial_authorization.issued.v1",
  ],
});

/** The B10 reads the api serves (design §13): GetCommissionStatement since B10-STATEMENTS-PAYOUTS. */
export const COMMERCIAL_SERVED_READ_IDS = Object.freeze(["GetCommissionStatement"] as const satisfies ReadonlyArray<CommercialReadOperationId>);

export function isServedCommercialRead(id: string): id is CommercialReadOperationId {
  return (COMMERCIAL_SERVED_READ_IDS as ReadonlyArray<string>).includes(id);
}

/** The declared replies of a served B10 read route: its READ envelope at 200 and the Problem document of its closed catalogue. */
export function commercialReadRouteResponses(operationId: CommercialReadOperationId): RouteResponses {
  if (!isServedCommercialRead(operationId)) throw new TypeError(`${operationId} is not a served commercial read (COMMERCIAL_SERVED_READ_IDS)`);
  return Object.freeze({
    operationId,
    declared: Object.freeze({ "200": Object.freeze({ contentType: HEADERS.contentType, schemaId: commercialReadResponseSchemaId(operationId) as KnownSchemaId }) }),
    problem: PROBLEM_RESPONSE,
    outcomes: COMMERCIAL_READ_OUTCOMES[operationId],
  });
}

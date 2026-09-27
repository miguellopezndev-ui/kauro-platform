/**
 * The served payment routes (docs/design/B09-payments-fiscal.md §10, D-API-B1): the commands whose routes the api registers,
 * and the reply declaration each one registers under (`config.responses`), which the api's send guard enforces and
 * tools/openapi.mjs documents under `paths` — every other B09 operation stays documented under `x-kauro-planned` until the
 * mandate that serves it lists it here. Stage-2 mandate M3 serves the payment service's side: the provider webhook (CMD030),
 * ExecuteRefund (CMD033) and ReconcilePayment (CMD034); the request side (CMD028, CMD029, CMD031, CMD032 and the reads) is
 * mandate M4's.
 *
 * A served command's declaration: its COMPLETED status with its envelope, the ACCEPTED envelope (202) when the command may leave a
 * provider effect unknown (D-PROTO-B2), and the Problem document for every other status, constrained to the command's closed
 * outcome catalogue (COMMERCE_COMMAND_OUTCOMES; B06 N13).
 */
import { HEADERS } from "../api/envelope.js";
import { PROBLEM_RESPONSE, type DeclaredResponse, type RouteResponses } from "../api/response-contract.js";
import { ACCEPTED_RESPONSE_SCHEMA_ID } from "../api/response-schemas.js";
import type { KnownSchemaId } from "../ports/schema-validator.js";
import type { CommerceCommandId } from "./contracts.js";
import { COMMERCE_COMMANDS } from "./contracts.js";
import { COMMERCE_COMMAND_OUTCOMES } from "./outcomes.js";
import { COMMERCE_COMMAND_RESPONSES, commerceCommandResponseSchemaId } from "./response-schemas.js";

/** The payment commands whose routes the api serves (mandate M3: the payment service's side). */
export const COMMERCE_SERVED_COMMAND_IDS: ReadonlyArray<CommerceCommandId> = Object.freeze(["CMD030", "CMD033", "CMD034"]);

export function isServedCommerceCommand(id: string): id is CommerceCommandId {
  return (COMMERCE_SERVED_COMMAND_IDS as ReadonlyArray<string>).includes(id);
}

/** The declared replies of a served payment command route (its `config.responses`). */
export function commerceCommandRouteResponses(command: CommerceCommandId): RouteResponses {
  if (!isServedCommerceCommand(command)) throw new TypeError(`${command} is not a served payment command (COMMERCE_SERVED_COMMAND_IDS)`);
  const reply = COMMERCE_COMMAND_RESPONSES[command];
  const declared: Record<string, DeclaredResponse> = {
    [String(reply.status)]: Object.freeze({ contentType: HEADERS.contentType, schemaId: commerceCommandResponseSchemaId(command) as KnownSchemaId }),
  };
  if (reply.accepted) declared["202"] = Object.freeze({ contentType: HEADERS.contentType, schemaId: ACCEPTED_RESPONSE_SCHEMA_ID });
  return Object.freeze({ operationId: COMMERCE_COMMANDS[command].name, declared: Object.freeze(declared), problem: PROBLEM_RESPONSE, outcomes: COMMERCE_COMMAND_OUTCOMES[command] });
}

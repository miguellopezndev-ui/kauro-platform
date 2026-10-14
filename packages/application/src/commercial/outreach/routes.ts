/**
 * The B12 routes the kit registers (plan docs/design/B12-outreach-plan.md §2; lane K2): every command and read of package B12 is bound here to
 * its catalogue spec, the admission spec the transport reads and the NOT_BUILT stub. The lanes (L-DRAFT, L-AUTH, L-SEND, L-ACT, L-SOURCE) replace
 * the `execute` bodies by their own handlers and touch none of the shared contracts. A stub never reaches a port or a row: it throws
 * OutreachNotBuilt, which no route maps to a success.
 */
import { isB12Operation } from "@kauro/domain";
import { B12_COMMERCIAL_COMMANDS } from "../contracts.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import { COMMERCIAL_READ_ROUTES, type CommercialReadOperationId } from "../response-schemas.js";
import type { ReadSpec } from "../../queries/reads.js";
import { OutreachNotBuilt, type OutreachHandlerName } from "./handlers.js";

/** The lane handler each B12 command id is served from (OUTREACH_HANDLERS names the file; the stub reports it). */
const COMMAND_HANDLER: Readonly<Record<keyof typeof B12_COMMERCIAL_COMMANDS, OutreachHandlerName>> = Object.freeze({
  CMD061: "prepare-draft",
  CMD062: "authorize",
  CMD063: "send",
  CMD064: "record-activity",
  PutOutreachContent: "put-content",
  PublishSalesResource: "publish-resource",
  RegisterSenderIdentity: "sender-identity",
  VerifySenderIdentity: "sender-identity",
  RecordSenderRevocation: "sender-identity",
  PrepareOutreachReview: "prepare-review",
  RecordOutreachDiagnosis: "diagnosis",
  RevokeOutreachAuthorization: "revoke-authorization",
  WithdrawOutreachChannelPolicy: "withdraw-policy",
  RecordProspectSource: "prospects/record-source",
  RecordProspectContact: "prospects/record-contact",
});

export type B12CommandId = keyof typeof B12_COMMERCIAL_COMMANDS;

const B12_READ_IDS = ["GetOutreachDraft", "GetOutreachReview", "ListSalesActivities", "GetOutreachMetrics", "GetSalesResource"] as const satisfies ReadonlyArray<CommercialReadOperationId>;
export type B12ReadId = (typeof B12_READ_IDS)[number];

const READ_HANDLER: Readonly<Record<B12ReadId, OutreachHandlerName>> = Object.freeze({
  GetOutreachDraft: "get-draft",
  GetOutreachReview: "get-review",
  ListSalesActivities: "list-activities",
  GetOutreachMetrics: "metrics",
  GetSalesResource: "resources",
});

/** The ids of the B12 reads the api serves (a subset of COMMERCIAL_SERVED_READ_IDS). */
export const B12_SERVED_READ_IDS: ReadonlyArray<B12ReadId> = Object.freeze([...B12_READ_IDS]);

/** The B12 command handlers, each a NOT_BUILT stub until its lane lands. */
export function createOutreachStubCommandHandlers(): { readonly [K in B12CommandId]: CommercialCommandHandler<unknown, unknown> } {
  const handlers: Partial<Record<B12CommandId, CommercialCommandHandler<unknown, unknown>>> = {};
  for (const id of Object.keys(B12_COMMERCIAL_COMMANDS) as B12CommandId[]) {
    const spec = B12_COMMERCIAL_COMMANDS[id] as unknown as CommercialCommandHandler<unknown, unknown>["spec"];
    const name = COMMAND_HANDLER[id];
    handlers[id] = {
      spec,
      admission: commercialAdmissionSpecOf(spec),
      execute: () => Promise.reject(new OutreachNotBuilt(name)),
    };
  }
  return handlers as { readonly [K in B12CommandId]: CommercialCommandHandler<unknown, unknown> };
}

/** The B12 read handlers, each a NOT_BUILT stub until its lane lands. */
export function createOutreachStubReadHandlers(): { readonly [K in B12ReadId]: CommercialReadHandler<unknown> } {
  const handlers: Partial<Record<B12ReadId, CommercialReadHandler<unknown>>> = {};
  for (const id of B12_READ_IDS) {
    const route = COMMERCIAL_READ_ROUTES[id];
    const name = READ_HANDLER[id];
    const admission: ReadSpec<string> = Object.freeze({ operationId: id, method: "GET", path: route.path, action: route.action, scope: "NONE", paginated: false, summary: route.summary, authority: route.authority });
    handlers[id] = { operationId: id, admission, execute: () => Promise.reject(new OutreachNotBuilt(name)) };
  }
  return handlers as { readonly [K in B12ReadId]: CommercialReadHandler<unknown> };
}

/** True for a B12 command the kit registers (a catalogue id CMD061..CMD064 or an operation of plan companion §R). */
export function isB12CommercialCommand(id: string): id is B12CommandId {
  return Object.prototype.hasOwnProperty.call(B12_COMMERCIAL_COMMANDS, id);
}

/** True for a B12 operation no catalogue id names (journaled under its own name; the registry has no row for it). */
export function isB12RegistryLessOperation(id: string): boolean {
  return isB12CommercialCommand(id) && isB12Operation(id);
}

export function isB12CommercialRead(id: string): id is B12ReadId {
  return (B12_READ_IDS as ReadonlyArray<string>).includes(id);
}

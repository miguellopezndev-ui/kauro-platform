/**
 * CMD027 CreateQuote of package B10 on B06's pipeline (mandate B10-COMMANDS-QUOTE; design §3.4, §3.5, §10): assembled over B09's request
 * runtime and the collaborators a deployment binds (the recurrence history and issuance core, the buyer type, the re-binding of a paid
 * purchase). The api composition registers every handler returned here.
 */
import type { CreateQuoteBody } from "../contracts.js";
import type { CreateQuoteView } from "../views.js";
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import { createQuoteHandler } from "./create-quote.js";
import type { QuoteCollaborators } from "./runtime.js";

export interface QuoteHandlers {
  readonly CMD027: CommercialCommandHandler<CreateQuoteBody, CreateQuoteView>;
}

export function createQuoteHandlers(runtime: CommerceRequestRuntime, co: QuoteCollaborators): QuoteHandlers {
  return Object.freeze({ CMD027: createQuoteHandler(runtime, co) });
}

export type { QuoteCollaborators, QuoteHoldPoint, QuoteReads } from "./runtime.js";
export { createQuoteHandler } from "./create-quote.js";
export type { QuotedSubject } from "./create-quote.js";

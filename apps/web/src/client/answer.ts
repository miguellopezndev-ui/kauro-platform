// What the browser knows after one call to the api (design D-STATE-1, D-GEN-1; 10 "frontend control flow uses the code…An unexpected
// 500 does not mean a command did not commit"). An answer is exactly one of four things, decided by the api client and never by prose:
//   REPLY      a contract-valid success body;
//   PROBLEM    a contract-valid Problem document (the stable code and reason drive control flow);
//   NO_ANSWER  the browser did not get a readable reply: the effect is unknown, so the state is Checking, never "failed";
//   INTEGRITY  a reply arrived and failed the generated guard (version skew between web and api): never rendered, never retried.
import type { AcceptedResponse, Problem } from "../api/generated.ts";

export type NoAnswerReason = "NETWORK" | "TIMEOUT" | "ABORTED" | "UNREADABLE";
export type IntegrityFailure = "REPLY_FAILED_CONTRACT" | "PROBLEM_FAILED_CONTRACT" | "UNEXPECTED_STATUS" | "UNEXPECTED_MEDIA_TYPE";

export type ApiAnswer<Body> =
  | { readonly kind: "REPLY"; readonly status: number; readonly correlationId: string; readonly body: Body }
  | { readonly kind: "PROBLEM"; readonly status: number; readonly correlationId: string; readonly problem: Problem }
  | { readonly kind: "NO_ANSWER"; readonly reason: NoAnswerReason; readonly status: number | null }
  | { readonly kind: "INTEGRITY"; readonly status: number; readonly correlationId: string | null; readonly failure: IntegrityFailure };

/** The success envelope of a command (10 "Responses and safe errors"): COMPLETED with the validated DTO, or ACCEPTED long work. */
export type CommandBody<Data> =
  | { readonly kind: "COMPLETED"; readonly version: number; readonly replayed: boolean; readonly data: Data }
  | AcceptedResponse;

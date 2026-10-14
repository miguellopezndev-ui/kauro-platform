/**
 * The answer of a provider call as the database's records name it, and the late evidence of a call whose answer arrived after the dispatcher
 * had stopped waiting (package B12, lane L-SEND; plan docs/design/B12-outreach-plan.md A3, D4, D4b, §W).
 *
 * classifyAnswer is the A3 classifier, a closed set: ACCEPTED (the provider's own message reference, never a delivery claim, R2-129), a
 * definitive REJECTED only for 400, 403, 413 and 429 (a refusal that proves no message was taken), a 403/429 WARNING likewise, and anything
 * else UNCERTAIN: a timeout, an abort, a lost answer, a 5xx and every other rejection status. An UNCERTAIN intent is never sent again
 * automatically. recordAnswer is the one unit of work that writes an answer: D4 for the claimant's own answer and D4b for a late ACCEPTED
 * answer, whose evidence row is UNIQUE (intent, fence) and moves a SUBMITTING or SEND_UNCERTAIN intent to PROVIDER_ACCEPTED.
 */
import type { OutreachSubmitAnswer } from "@kauro/application";
import type { CorrelationId } from "@kauro/domain";
import { outreachSendOf, type OutcomeAnswer } from "@kauro/persistence";
import type { OutreachLeaseRef, OutreachRuntime } from "./dispatcher.js";

const DEFINITIVE: ReadonlySet<number> = new Set([400, 403, 413, 429]);

export function classifyAnswer(answer: OutreachSubmitAnswer): OutcomeAnswer {
  switch (answer.kind) {
    case "ACCEPTED":
      return { kind: "ACCEPTED", ref: answer.providerMessageRef };
    case "WARNING":
      return { kind: "REJECTED_DEFINITIVE", status: answer.status };
    case "REJECTED":
      if (answer.status === 401) return { kind: "AUTH_REVOKED" };
      return DEFINITIVE.has(answer.status) ? { kind: "REJECTED_DEFINITIVE", status: answer.status as 400 | 403 | 413 | 429 } : { kind: "UNCERTAIN", cause: `PROVIDER_STATUS_${answer.status}` };
    case "UNKNOWN":
      return { kind: "UNCERTAIN", cause: answer.reason };
  }
}

/** The answer of a call that threw instead of answering: the provider may have taken the message. */
export function thrownAnswer(e: unknown): OutcomeAnswer {
  const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
  return { kind: "UNCERTAIN", cause: aborted ? "ABORTED" : "PROVIDER_ERROR" };
}

/** D4 / D4b: writes the answer in a unit of work of the outreach service, under the lease and fence the caller holds (or held, for late evidence). */
export async function recordAnswer(rt: OutreachRuntime, intentId: string, lease: OutreachLeaseRef, answer: OutcomeAnswer): Promise<string> {
  return rt.units.run({ kind: "SERVICE", serviceId: "outreach-service", correlationId: rt.ids.next() as CorrelationId }, (uow) => outreachSendOf(uow).record(intentId, lease, answer));
}

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
import { DomainFailure, type CorrelationId } from "@kauro/domain";
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
  const context = () => ({ kind: "SERVICE", serviceId: "outreach-service", correlationId: rt.ids.next() as CorrelationId }) as const;
  for (;;) {
    try {
      return await rt.units.run(context(), (uow) => outreachSendOf(uow).record(intentId, lease, answer));
    } catch (e) {
      // a D4 whose unit could not commit (no capacity, a lock wait past the statement timeout) is retried until uncertain_after + d4Grace (plan A3):
      // a received answer is recorded before a repeat can be claimed, unless the database stays unavailable for the whole grace (residual §5)
      if (!(e instanceof DomainFailure) || e.code !== "CAPACITY_UNAVAILABLE") throw e;
      const open = await rt.units.run(context(), (uow) => outreachSendOf(uow).d4WindowOpen(intentId)).catch(() => false);
      if (!open) throw e;
      await new Promise((resolve) => setTimeout(resolve, D4_RETRY_PAUSE_MS));
    }
  }
}

const D4_RETRY_PAUSE_MS = 100;

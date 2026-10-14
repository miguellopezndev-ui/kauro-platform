/**
 * D5 recovery of the outreach sends (package B12, lane L-SEND; plan docs/design/B12-outreach-plan.md A3, D5, §W): an intent still SUBMITTING
 * past its uncertain_after (submitted_at + 37 s, stamped by the database) lost its answer: the dispatcher crashed, the lease was taken over
 * or the call outlived its bound. It becomes SEND_UNCERTAIN, never QUEUED again: nothing sends it a second time automatically. Both the
 * due test and the transition are judged at the database's clock inside the accessor; this module only walks the due list, each intent in
 * its own unit of work, and stops at the first fenced one.
 */
import type { CorrelationId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { outreachSendOf } from "@kauro/persistence";
import type { OutreachLeaseRef, OutreachRuntime } from "./dispatcher.js";

export interface RecoveryPass {
  readonly recovered: ReadonlyArray<string>;
  readonly untouched: ReadonlyArray<string>;
  /** The lease was taken over: the walk stopped. */
  readonly fenced: boolean;
}

const serviceContext = (rt: OutreachRuntime) => ({ kind: "SERVICE" as const, serviceId: "outreach-service", correlationId: rt.ids.next() as CorrelationId });

export async function recoverDue(rt: OutreachRuntime, lease: OutreachLeaseRef, limit: number): Promise<RecoveryPass> {
  const due = await rt.units.run(serviceContext(rt), (uow) => outreachSendOf(uow).dueForRecovery(limit));
  const recovered: string[] = [];
  const untouched: string[] = [];
  for (const intentId of due) {
    try {
      const result = await rt.units.run(serviceContext(rt), (uow) => outreachSendOf(uow).recover(intentId, lease));
      (result === "SEND_UNCERTAIN" ? recovered : untouched).push(intentId);
    } catch (e) {
      if (e instanceof DomainFailure && e.details.reason === "LEASE_FENCED") return { recovered, untouched, fenced: true };
      rt.onBackgroundFailure(intentId, e);
    }
  }
  return { recovered, untouched, fenced: false };
}

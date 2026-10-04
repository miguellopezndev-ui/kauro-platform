/**
 * The platform's ModelTaskJournalPort (package B08, mandate B08-PERSISTENCE-AUDIT; @kauro/application ports/core-ports.ts; design
 * docs/design/B08-audit-approval-jobs.md §3, D8-AUD-3, D8-PORT-3): the fenced log the Intelligence core dispatches under, over
 * migration 0023's model_task_journal. The core calls it outside any transaction of its caller (D8-AUD-2), so each call is a unit of
 * work of its own — a control-plane unit bound to the audit's agency (B07 D-CTRL-1) — and every append is made by the INTERPRET step
 * that holds the audit's current fence: a stale step's append is refused (KA080), a stale length answers LENGTH_MISMATCH with the
 * journal's actual length. The model tasks' dispatch intents and their reservations are the audit store's (beginDispatch over B06's
 * request journal); this port keeps the core's own events, opaque to the platform. The shape is @kauro/application's
 * ModelTaskJournalPort, written structurally here because the persistence adapter does not depend on the application package.
 */
import type { Id } from "@kauro/contracts";
import type { AuditId, AuditUnitOfWorkFactory, ExecutionContext, JournalAppendOutcome } from "@kauro/domain";

/** The INTERPRET step a journal instance appends for: its audit and the fence it claimed. */
export interface ModelTaskJournalBinding {
  readonly auditId: AuditId;
  readonly stepFence: number;
}

/** @kauro/application ModelTaskJournalPort. */
export interface PgModelTaskJournal {
  append(runId: Id, event: Readonly<Record<string, unknown>>, expectedLength: number): Promise<JournalAppendOutcome>;
  read(runId: Id): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
}

/** The journal of one INTERPRET step, each call a unit of work of `units` under `context` (a SYSTEM context bound to the agency). */
export function modelTaskJournalOf(units: AuditUnitOfWorkFactory, context: ExecutionContext, binding: ModelTaskJournalBinding): PgModelTaskJournal {
  return {
    append: (runId, event, expectedLength) =>
      units.run(context, (uow) => uow.audits.appendJournal({ runId, auditId: binding.auditId, stepFence: binding.stepFence, event, expectedLength })),
    read: async (runId) => (await units.run(context, (uow) => uow.audits.journalOf(runId))).map((entry) => entry.event),
  };
}

/**
 * The recovery journal's tail (package B16 lane L6; R2 14 "External-effect recovery journal"): the authority facts a restore must not
 * forget that no consumer journals — a membership revoked, a retention extension granted, a provider capture state recorded — copied
 * from the committed domain events into the journal outside the restore boundary, each under its subject's identity (idempotent).
 *
 * Commit-safe (persistence PgJournalTail): each pass reads the events of transactions older than every running one, from the source's
 * horizon to the snapshot's xmin, journals them, and only then moves the horizon (compare-and-set). A crash between the two re-reads
 * the same events next pass: ALREADY_PRESENT. A released restore re-bases the horizon on the restored database (restore-runner S8).
 */
import type { AuditUnits, RecoveryJournalPort } from "@kauro/application";
import type { CorrelationId, IdGenerator } from "@kauro/domain";
import { journalTailOf, type TailedEvent } from "@kauro/persistence";
import { discovery } from "../work.js";

export const RECOVERY_JOURNAL_TAIL_SOURCE = "platform-events";
export const TAILED_EVENT_TYPES: ReadonlyArray<string> = Object.freeze(["membership.revoked.v1", "retention_record.extended.v1", "capture.completed.v1", "capture.reversed.v1"]);

const SERVICE = "recovery-journal";

export type TailedEntry = Parameters<RecoveryJournalPort["record"]>[0];

/** The journal entry of a tailed event (its subject's identity, the members a restore replays). */
export function tailedEntryOf(e: TailedEvent): TailedEntry {
  const p = e.payload;
  switch (e.eventType) {
    case "membership.revoked.v1":
      return {
        entryId: `revocation:${String(p["membershipId"])}`,
        kind: "REVOCATION",
        agencyId: e.agencyId,
        body: { membershipId: p["membershipId"], agencyId: e.agencyId, byMembershipId: p["byMembershipId"], byUserId: e.actorId, reasonCode: p["reasonCode"], eventId: e.eventId },
      };
    case "retention_record.extended.v1": {
      if (e.extension === null) throw new Error(`extension ${String(p["extensionId"])} of event ${e.eventId} is not readable`);
      return { entryId: `extension:${String(e.extension["extensionId"])}`, kind: "EXTENSION", agencyId: e.agencyId, body: { ...e.extension, agencyId: e.agencyId, eventId: e.eventId } };
    }
    case "capture.completed.v1":
    case "capture.reversed.v1": {
      const status = e.eventType === "capture.completed.v1" ? "COMPLETED" : "REVERSED";
      return { entryId: `capture:${String(p["captureId"])}:${status}`, kind: "PAYMENT", agencyId: e.agencyId, body: { subjectKind: "CAPTURE", captureId: p["captureId"], agencyId: e.agencyId, status, eventId: e.eventId } };
    }
    default:
      throw new RangeError(`the recovery journal does not tail ${e.eventType}`);
  }
}

export interface RecoveryJournalTailDependencies {
  readonly journal: RecoveryJournalPort;
  readonly ids: IdGenerator;
  readonly source?: string;
}

export class RecoveryJournalTail {
  constructor(private readonly deps: RecoveryJournalTailDependencies) {}

  /** One pass: what was journaled and whether this pass moved the horizon (false: another tail moved it first). */
  async sweep(units: AuditUnits): Promise<{ readonly read: number; readonly appended: number; readonly advanced: boolean }> {
    const source = this.deps.source ?? RECOVERY_JOURNAL_TAIL_SOURCE;
    const from = await this.deps.journal.cursor(source);
    const read = await units.runSource(discovery(SERVICE, this.deps.ids.next() as CorrelationId), (uow) => journalTailOf(uow).read(TAILED_EVENT_TYPES, from));
    let appended = 0;
    for (const event of read.events) {
      if ((await this.deps.journal.record(tailedEntryOf(event))) === "APPENDED") appended += 1;
    }
    const advanced = await this.deps.journal.advanceCursor(source, from, read.horizon);
    return { read: read.events.length, appended, advanced };
  }
}

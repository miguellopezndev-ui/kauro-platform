/**
 * AUTHORITY_JOURNAL (docs/design/B07-upload-source-lifecycle.md §12.4; decisions D-RESTORE-1, D-RESTORE-2, D-CTRL-8; B07-F8, re-check N5,
 * FINAL-N1; 09 "Deletion receipts and restoration": tombstones survive separately from the database and restoration applies them, in
 * order, before traffic; 14 "Minimal durable facts outside the primary restore boundary").
 *
 * For every event routed here it appends exactly the tombstone AUTHORITY_TOMBSTONES names — its closed kind and the terminal state
 * as the subject's own machine names it — to the external journal (AuthorityJournalPort, idempotent by event id), after reading the
 * subject in that state: an upload CANCELLED, EXPIRED or REJECTED; a revision CANCELLED, SUPERSEDED, REJECTED, EXPIRED or DELETED; a
 * file ADMISSION_REVOKED. A subject found in any other state is an integrity incident — an event whose subject never took the
 * transition it announces (a forged event on a version bump, Q-B07-22) — and is dead-lettered, never tombstoned (07: consumers
 * verify state before an effect).
 *
 * The tombstone is minimal (14: scoped ids, instants, sequence and evidence hash; no CRM payload): the domain event id (the
 * idempotence key), the agency, the revision the subject's authority belonged to, the subject, its state, the instant the database
 * recorded for the transition (D-CLOCK-1), the event's sequence (restore reconciliation applies tombstones in this order) and the
 * KAURO_AUTHORITY_TOMBSTONE_V1 digest of those members.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AuthorityJournalPort, AuthorityTombstone, ConsumerOutcome, OutboxConsumer } from "@kauro/application";
import { AUTHORITY_TOMBSTONES } from "@kauro/application";
import {
  authorityTombstoneHashOf,
  isUuidV7,
  type AgencyId,
  type CausationId,
  type DomainEventRecord,
  type RevisionId,
  type SourceFileId,
  type SourceUnitOfWork,
  type SourceUnitOfWorkFactory,
  type SystemContext,
  type UploadId,
} from "@kauro/domain";
import { boundTo, type WorkItem } from "../work.js";

export interface AuthorityJournalDependencies {
  readonly journal: AuthorityJournalPort;
  readonly retryAfterSeconds?: number;
}

/** The aggregate each routed event's subject is (the tombstone's subject is the event's aggregate). */
const SUBJECT_KIND: Readonly<Record<keyof typeof AUTHORITY_TOMBSTONES, "upload_session" | "dataset_revision" | "source_file">> = Object.freeze({
  "upload_session.cancelled.v1": "upload_session",
  "upload_session.expired.v1": "upload_session",
  "upload_session.rejected.v1": "upload_session",
  "dataset_revision.cancelled.v1": "dataset_revision",
  "dataset_revision.superseded.v1": "dataset_revision",
  "dataset_revision.rejected.v1": "dataset_revision",
  "dataset_revision.expired.v1": "dataset_revision",
  "dataset_revision.deleted.v1": "dataset_revision",
  "source_file.admission_revoked.v1": "source_file",
});

/** What the subject is now: its current state, the revision its authority belonged to and the instant of its terminal transition. */
interface Subject {
  readonly state: string;
  readonly revisionId: RevisionId;
  readonly terminalAt: UtcInstant | undefined;
}

function isRoutedHere(eventType: string): eventType is keyof typeof AUTHORITY_TOMBSTONES {
  return Object.prototype.hasOwnProperty.call(AUTHORITY_TOMBSTONES, eventType);
}

export class AuthorityJournal implements OutboxConsumer {
  readonly consumer = "AUTHORITY_JOURNAL" as const;

  constructor(private readonly deps: AuthorityJournalDependencies) {}

  async handle(event: DomainEventRecord, context: SystemContext, units: SourceUnitOfWorkFactory): Promise<ConsumerOutcome> {
    if (!isRoutedHere(event.eventType)) return { kind: "DEAD_LETTER", reason: "EVENT_WITHOUT_TOMBSTONE_KIND" };
    const named = AUTHORITY_TOMBSTONES[event.eventType];
    if (context.agencyId === undefined || event.aggregateKind !== SUBJECT_KIND[event.eventType] || !isUuidV7(event.aggregateId)) return { kind: "DEAD_LETTER", reason: "EVENT_WITHOUT_SUBJECT" };
    const item: WorkItem = { serviceId: context.serviceId, agencyId: context.agencyId, correlationId: context.correlationId, causationId: event.eventId as unknown as CausationId };
    const subject = await units.runSource(boundTo(item), (uow): Promise<Subject | null> => this.#subjectOf(uow, event));
    if (subject === null) return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_VISIBLE" };
    // verify the subject before the effect (D-RESTORE-1): only a subject in the terminal state the tombstone names is tombstoned
    if (subject.state !== named.state) return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_IN_TOMBSTONE_STATE" };
    const members = {
      tombstoneId: event.eventId,
      kind: named.kind,
      agencyId: context.agencyId as AgencyId,
      revisionId: subject.revisionId,
      subjectId: event.aggregateId,
      state: named.state,
      occurredAt: subject.terminalAt ?? event.createdAt,
      sequence: event.sequence,
    };
    const tombstone: AuthorityTombstone = { ...members, evidenceHash: authorityTombstoneHashOf(members) };
    try {
      await this.deps.journal.append(tombstone);
    } catch {
      return { kind: "RETRY", afterSeconds: this.deps.retryAfterSeconds ?? 60, reason: "AUTHORITY_JOURNAL_UNAVAILABLE" };
    }
    return { kind: "DONE" };
  }

  async #subjectOf(uow: SourceUnitOfWork, event: DomainEventRecord): Promise<Subject | null> {
    switch (event.aggregateKind) {
      case "upload_session": {
        const upload = await uow.sources.uploads.get(event.aggregateId as UploadId);
        if (upload === null) return null;
        const terminalAt = upload.state === "CANCELLED" ? upload.cancelledAt : upload.state === "EXPIRED" ? upload.expiredAt : upload.state === "REJECTED" ? upload.rejectedAt : undefined;
        return { state: upload.state, revisionId: upload.revisionId, terminalAt };
      }
      case "dataset_revision": {
        const revision = await uow.sources.revisions.get(event.aggregateId as RevisionId);
        if (revision === null) return null;
        const at: Readonly<Record<string, UtcInstant | undefined>> = {
          CANCELLED: revision.cancelledAt,
          SUPERSEDED: revision.supersededAt,
          REJECTED: revision.rejectedAt,
          EXPIRED: revision.expiredAt,
          DELETED: revision.deletedAt,
        };
        return { state: revision.state, revisionId: revision.revisionId, terminalAt: at[revision.state] };
      }
      case "source_file": {
        const file = await uow.sources.files.get(event.aggregateId as SourceFileId);
        if (file === null) return null;
        return { state: file.state, revisionId: file.originRevisionId, terminalAt: file.revokedAt };
      }
      default:
        return null;
    }
  }
}

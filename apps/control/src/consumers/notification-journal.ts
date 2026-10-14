/**
 * NOTIFICATIONS with its dispatch identity journaled outside the restore boundary (package B16 lane L6, R2-074 "Reconcile external
 * sent-event identity and avoid another message unless deliberately authorized as a correction"; plan conflict C6).
 *
 * The identity of a notification is derived from the event it announces (KAURO_NOTIFICATION_IDENTITY_V1 over the event id), never
 * random, and travels to the provider as its idempotency key. The consumer:
 *   1. finds the identity in the journal -> DONE without a dispatch (a restored outbox record that slipped past the restore's
 *      suppression, or a redelivery, sends nothing);
 *   2. otherwise dispatches it through the sender (the live provider is package B15: PART), then journals the identity (NOTIFICATION
 *      entry). A crash between the two leaves the identity unjournaled: the redelivery dispatches the SAME identity again, which the
 *      provider deduplicates by its key — never a second message under another identity.
 * A restore applies every NOTIFICATION entry by settling the restored outbox record DELIVERED before the gate opens (restore-runner).
 */
import { createHash } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import type { ConsumerOutcome, NotificationSenderPort, OutboxConsumer, RecoveryJournalPort } from "@kauro/application";
import type { DomainEventRecord, SourceUnitOfWorkFactory, SystemContext } from "@kauro/domain";

export const NOTIFICATIONS_CONSUMER = "NOTIFICATIONS" as const;

/** The dispatch identity of the notification an event announces (the provider's idempotency key and the journal entry id). */
export function notificationIdentityOf(eventId: string): Sha256Hex {
  return createHash("sha256").update(`KAURO_NOTIFICATION_IDENTITY_V1\n${eventId}`).digest("hex") as Sha256Hex;
}

export interface NotificationJournalDependencies {
  readonly journal: RecoveryJournalPort;
  readonly sender: NotificationSenderPort;
  readonly retryAfterSeconds?: number;
}

export class NotificationJournal implements OutboxConsumer {
  readonly consumer = NOTIFICATIONS_CONSUMER;

  constructor(private readonly deps: NotificationJournalDependencies) {}

  async handle(event: DomainEventRecord, _context: SystemContext, _units: SourceUnitOfWorkFactory): Promise<ConsumerOutcome> {
    const identity = notificationIdentityOf(event.eventId);
    const retry = (reason: string): ConsumerOutcome => ({ kind: "RETRY", afterSeconds: this.deps.retryAfterSeconds ?? 60, reason });
    try {
      if (await this.deps.journal.has(identity)) return { kind: "DONE" };
    } catch {
      return retry("AUTHORITY_JOURNAL_UNAVAILABLE");
    }
    try {
      await this.deps.sender.send({ identity, eventId: event.eventId, eventType: event.eventType, agencyId: event.agencyId ?? null });
    } catch {
      return retry("NOTIFICATION_PROVIDER_UNAVAILABLE");
    }
    try {
      await this.deps.journal.record({ entryId: identity, kind: "NOTIFICATION", agencyId: event.agencyId ?? null, body: { identity, eventId: event.eventId, eventType: event.eventType, consumer: NOTIFICATIONS_CONSUMER } });
    } catch {
      // the dispatch happened under its identity; the redelivery re-sends the same identity (deduplicated by the provider) and journals it
      return retry("AUTHORITY_JOURNAL_UNAVAILABLE");
    }
    return { kind: "DONE" };
  }
}

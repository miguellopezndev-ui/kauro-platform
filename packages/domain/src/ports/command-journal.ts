/**
 * Command journal port: the durable idempotency record of manual 10 "Idempotency contract" (table kauro.command_journal).
 *
 * Protocol inside one unit of work:
 *  1. `reserve(identity, digest)` inserts the intent row (state RESERVED) as the first write of the command. The unique key on
 *     the identity makes a concurrent duplicate block until the first transaction ends: if it committed, the duplicate reads
 *     the committed row and returns the same result; if it rolled back, the duplicate proceeds as the first request.
 *  2. The command executes and `commit(entryId, result)` records the response and resource link in the same transaction and
 *     returns the entry as stored. The stored response is the answer of this request as well (decision D-PORT-2): the first
 *     execution, a concurrent duplicate and a retry after a lost response all answer with the same durable record, byte for
 *     byte once serialized ("A concurrent duplicate receives the same durable operation reference or final result"; S052
 *     "identical replay recovers the original durable result").
 *  3. A later request with the same identity finds the COMMITTED row: same digest replays the stored response; a different
 *     digest is IDEMPOTENCY_CONFLICT. A RESERVED row seen after commit belongs to a multi-transaction operation (later
 *     packages) and replays as pending (OPERATION_PENDING).
 * A rejected command rolls its reservation back with everything else: rejections leave no journal row (decision D-IDEM-2).
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { CommandJournalEntry, IdempotencyIdentity } from "../model/idempotency.js";
import type { JournalEntryId } from "../model/ids.js";

export type ReservationOutcome =
  | { readonly kind: "RESERVED"; readonly entryId: JournalEntryId }
  | { readonly kind: "REPLAY"; readonly entry: CommandJournalEntry }
  | { readonly kind: "CONFLICT"; readonly entry: CommandJournalEntry }
  | { readonly kind: "PENDING"; readonly entry: CommandJournalEntry };

export interface JournalCommit {
  readonly responseStatus: number;
  readonly responseBody: unknown;
  readonly resourceKind: string;
  readonly resourceId: string;
}

export interface CommandJournal {
  reserve(identity: IdempotencyIdentity, requestDigest: Sha256Hex, correlationId: string): Promise<ReservationOutcome>;
  /** Completes a RESERVED entry (COMMITTED, response, resource link) and returns it exactly as the journal stored it. */
  commit(entryId: JournalEntryId, result: JournalCommit): Promise<CommandJournalEntry>;
  /** Marks a reservation whose external effect is unknown (later packages: payments, providers). */
  markUncertain(entryId: JournalEntryId): Promise<void>;
  find(identity: IdempotencyIdentity): Promise<CommandJournalEntry | null>;
}

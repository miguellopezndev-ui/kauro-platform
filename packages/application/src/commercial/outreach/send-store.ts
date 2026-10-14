/**
 * What the L-SEND handler (package B12; plan docs/design/B12-outreach-plan.md §L, §M, CMD063) runs on: the send records of a unit of work
 * behind one port, so that the handler holds no SQL and no advisory lock. The persistence adapter (@kauro/persistence PgOutreachSend,
 * outreachSendOf(uow)) implements it structurally: queueSend takes its whole serializer set in the one global order (L1 and L2 are the
 * access decision and the journal reservation the request runtime has already done), judges the locked facts in one statement at the
 * database's instant, and only then writes the intent and its draft edge. A refusal is a DomainFailure; nothing is written before it.
 */
import type { UnitOfWork } from "@kauro/domain";
import type { CommercialAuthorizer } from "../authorizer.js";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";

export type SendActor = { readonly kind: "SELLER"; readonly userId: string; readonly sellerId: string } | { readonly kind: "OWNER"; readonly userId: string };

/** What the sealed message is built from; the sealer returns the payload hash, or null while the deployment's compliance configuration is absent (A13, A15). */
export interface SendSealFacts {
  readonly intentId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}
export interface OutreachSealer {
  seal(facts: SendSealFacts): string | null;
}

export interface QueueSendRequest {
  readonly intentId: string;
  readonly draftId: string;
  readonly authorizationId: string;
  readonly actor: SendActor;
  readonly expectedVersion: number;
  readonly contentHash: string;
  readonly seal: (facts: SendSealFacts) => string | null;
}

export interface QueuedSendRecord {
  readonly intentId: string;
  readonly state: "QUEUED";
  readonly draftId: string;
  readonly payloadHash: string;
  readonly purpose: string;
  readonly route: string;
  readonly senderId: string;
  readonly prospectId: string;
  readonly authorizationId: string;
  readonly personUserId: string;
}

export interface OutreachSendStore {
  queueSend(input: QueueSendRequest): Promise<QueuedSendRecord>;
}

export interface OutreachSendCollaborators {
  readonly authorizer: CommercialAuthorizer;
  readonly sends: (uow: UnitOfWork) => OutreachSendStore;
  readonly sealer: OutreachSealer;
}

export interface SendAuthorizedOutreachBody {
  readonly expectedVersion: number;
  readonly authorizationId: string;
  readonly contentHash: string;
}

/** CMD063's answer: the intent, QUEUED; delivery is never claimed (R2-129). */
export interface SentIntentView {
  readonly intentId: string;
  readonly draftId: string;
  readonly state: "QUEUED";
  readonly authorizationId: string;
  readonly payloadHash: string;
}

export interface SendCommandHandler<Body, View> {
  readonly operation: string;
  execute(envelope: CommandEnvelope<Body>): Promise<CommandResult<View>>;
}

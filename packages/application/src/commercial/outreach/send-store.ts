/**
 * What the L-SEND handlers (package B12; plan docs/design/B12-outreach-plan.md §L, §M, CMD063 and companion §R) run on: the send and sender
 * records of a unit of work behind ports, so that a handler holds no SQL and no advisory lock. The persistence adapters (@kauro/persistence
 * PgOutreachSend / outreachSendOf(uow), PgOutreachSenders / outreachSendersOf(uow)) implement them structurally: queueSend takes its whole
 * serializer set in the one global order (L1 and L2 are the access decision and the journal reservation the request runtime has already
 * done), judges the locked facts in one statement at the database's instant, and only then writes the intent and its draft edge. A refusal
 * is a DomainFailure; nothing is written before it.
 */
import type { UnitOfWork } from "@kauro/domain";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommercialAuthorizer } from "../authorizer.js";

export type { SendAuthorizedOutreachBody } from "../contracts.js";

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
  readonly queuedAt: string;
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

/** A sender identity as the store reads it (the address stays inside: no view answers it). */
export interface SenderRecordView {
  readonly senderId: string;
  readonly userId: string;
  readonly address: string;
  readonly route: "GMAIL_API" | "RESEND_TRANSACTIONAL";
  readonly state: "PENDING_VERIFICATION" | "VERIFIED" | "REVOKED";
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface OutreachSenderStore {
  register(input: {
    readonly senderId: string;
    readonly userId: string;
    readonly address: string;
    readonly route: "GMAIL_API" | "RESEND_TRANSACTIONAL";
    readonly consentEvidenceRef: string | null;
    readonly recordedByUserId: string;
  }): Promise<SenderRecordView>;
  verify(senderId: string, verificationEvidenceHash: string): Promise<SenderRecordView>;
  revoke(senderId: string): Promise<SenderRecordView>;
}
export interface OutreachSenderCollaborators {
  readonly authorizer: CommercialAuthorizer;
  readonly senders: (uow: UnitOfWork) => OutreachSenderStore;
  readonly assurance: AssuranceVerifier;
}

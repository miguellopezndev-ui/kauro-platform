/**
 * What the L-DRAFT handlers (package B12; plan docs/design/B12-outreach-plan.md §L, §M) run on: the draft, content and resource records
 * of a unit of work, behind one port so that the handlers hold no SQL and no advisory lock. The persistence adapter
 * (@kauro/persistence PgOutreachDrafts, outreachDraftsOf(uow)) implements it: each write method takes its whole serializer set in the one
 * global order (L1 and L2 are the access decision and the journal reservation the request runtime has already done), judges the locked
 * facts in one statement at the database's instant, and only then writes. A refusal is a DomainFailure; nothing is written before it.
 */
import type { AssuranceProofId, SellerId, UserId } from "@kauro/domain";
import type { CommercialAuthorizer } from "../authorizer.js";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import type { ReadRequest, ReadResult } from "../../queries/reads.js";
import type { UnitOfWork } from "@kauro/domain";

export type DraftPurpose = "REQUESTED_REPLY" | "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP";

/** Who prepares a draft: an ACTIVE seller (only its own assigned prospects and its own sender identities) or the corporate owner. */
export type DraftActor = { readonly kind: "SELLER"; readonly userId: UserId; readonly sellerId: SellerId } | { readonly kind: "OWNER"; readonly userId: UserId };

export interface PrepareDraftInput {
  readonly draftId: string;
  readonly actor: DraftActor;
  readonly prospectId: string;
  readonly senderId: string;
  readonly purpose: DraftPurpose;
  readonly contentRef: string;
  readonly provenanceEvidenceHash: string;
  readonly resourceIds: ReadonlyArray<string>;
}

export interface PreparedDraft {
  readonly draftId: string;
  readonly version: 1;
  readonly state: "DRAFT";
  readonly contentHash: string;
}

export interface PublishResourceInput {
  readonly resourceId: string;
  /** Absent: a new family, published as version 1. */
  readonly familyId: string | null;
  /** The CURRENT version the publisher read; present exactly when `familyId` names an existing family. */
  readonly expectedVersion: number | null;
  readonly contentRef: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly publishedByUserId: UserId;
}

export interface PublishedResource {
  readonly resourceId: string;
  readonly familyId: string;
  readonly version: number;
  readonly state: "CURRENT";
}

export interface DraftRecord {
  readonly draftId: string;
  readonly prospectId: string;
  readonly senderId: string;
  readonly purpose: DraftPurpose;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly provenanceEvidenceHash: string;
  readonly version: number;
  readonly state: string;
  readonly resourceIds: ReadonlyArray<string>;
}

export interface ResourceRecord {
  readonly resourceId: string;
  readonly familyId: string;
  readonly version: number;
  readonly state: "CURRENT" | "SUPERSEDED";
  /** The CURRENT resource of the family (the resource itself while it is CURRENT). */
  readonly currentResourceId: string;
  readonly contentRef: string;
  readonly capabilityIds: ReadonlyArray<string>;
}

export interface OutreachDraftStore {
  /** CMD061: L3 S, L5 S, L6 S, L6p S, L7 S, L8 S, L10 X, judge, then the draft and its resource bindings. */
  prepareDraft(input: PrepareDraftInput): Promise<PreparedDraft>;
  /** PutOutreachContent: content-addressed insert; the same subject and body is the same id, whoever puts it. Returns the id. */
  putContent(content: { readonly subject: string; readonly body: string }, recordedByUserId: UserId): Promise<string>;
  /** PublishSalesResource: L5 S, L6 X of the family, judge, supersede n, insert n+1 CURRENT with its capability claims. */
  publishResource(input: PublishResourceInput): Promise<PublishedResource>;
  /** A draft as the caller's own policies show it; null when it is not visible (a foreign and an unknown id answer alike). */
  draftOf(draftId: string): Promise<DraftRecord | null>;
  resourceOf(resourceId: string): Promise<ResourceRecord | null>;
  /** The latest STEP_UP proof of the person (its own, by the self policy), if any; the caller judges its freshness. */
  latestStepUpProof(userId: UserId): Promise<AssuranceProofId | undefined>;
}

/** The collaborators a deployment binds for the L-DRAFT handlers. */
export interface OutreachDraftCollaborators {
  readonly authorizer: CommercialAuthorizer;
  readonly drafts: (uow: UnitOfWork) => OutreachDraftStore;
  /** B06's step-up verifier (PublishSalesResource is owner + step-up). */
  readonly assurance: AssuranceVerifier;
}

// --- the views the handlers answer (no contact detail, no body: the draft names its content by reference, plan A17) ------------------------

export interface OutreachDraftView {
  readonly draftId: string;
  readonly prospectId: string;
  readonly senderIdentityRef: string;
  readonly purpose: DraftPurpose;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly provenanceEvidenceHash: string;
  readonly resourceIds: ReadonlyArray<string>;
  readonly version: number;
  readonly state: string;
}

export interface PreparedDraftView {
  readonly draftId: string;
  readonly version: number;
  readonly state: "DRAFT";
  readonly contentHash: string;
}

export interface OutreachContentView {
  readonly contentId: string;
}

export interface SalesResourceView {
  readonly resourceId: string;
  readonly familyId: string;
  readonly version: number;
  readonly state: "CURRENT" | "SUPERSEDED";
  readonly currentResourceId: string;
  readonly contentRef: string;
  readonly capabilityIds: ReadonlyArray<string>;
}

export interface PublishedResourceView {
  readonly resourceId: string;
  readonly familyId: string;
  readonly version: number;
  readonly state: "CURRENT";
}

/**
 * A served L-DRAFT command before its registration: the journaled operation name and its execution. The catalogue spec, the transport's
 * admission spec and the route are lane K2's (the registration files); a deployment composes them with this handler.
 */
export interface DraftCommandHandler<Body, View> {
  /** The journal's operation name (CMD061 for the registry command; the companion §R names for the others). */
  readonly operation: string;
  execute(envelope: CommandEnvelope<Body>): Promise<CommandResult<View>>;
}

/** A served L-DRAFT read before its registration. */
export interface DraftReadHandler<View> {
  /** The read's operation id (GetOutreachDraft, GetSalesResource). */
  readonly operationId: string;
  execute(request: ReadRequest): Promise<ReadResult<View>>;
}

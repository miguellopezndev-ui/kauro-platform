/**
 * Ports of the two public routes (B11 D-PUB-1..D-PUB-6): the store that admits a fit inquiry, and the reader of the capability
 * publication. Both are used outside any tenant context, by a caller who has not signed in.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { ServiceMode } from "../model/aggregates.js";
import type { InquiryAdmissionKeys, InquiryContent } from "../model/inquiry.js";
import type { CapabilityId, EventId, InquiryId } from "../model/ids.js";

export interface InquiryAdmissionRequest {
  /** Minted by the caller; stored when the inquiry is accepted, discarded when it is a replay or is limited. */
  readonly inquiryId: InquiryId;
  readonly eventId: EventId;
  /** The instant the request is admitted at; every window is measured from it. */
  readonly now: UtcInstant;
  readonly keys: InquiryAdmissionKeys;
  readonly content: InquiryContent;
}

export type InquiryAdmission =
  /** Stored now: one inquiry row, one event row and the three admission keys, in one transaction. */
  | { readonly kind: "ACCEPTED"; readonly inquiryId: InquiryId; readonly receivedAt: UtcInstant }
  /** The same content was accepted less than 24 hours ago: that inquiry, and nothing written, nothing counted. */
  | { readonly kind: "REPLAYED"; readonly inquiryId: InquiryId; readonly receivedAt: UtcInstant }
  /** A limiter is exhausted: nothing written; the seconds until the first counted inquiry leaves its window. */
  | { readonly kind: "LIMITED"; readonly retryAfterSeconds: number };

/**
 * Admits one inquiry. The three keys are serialized by transaction-scoped advisory locks taken in a fixed order, so two requests
 * that share a key are decided one after the other; the replay check runs before the limiters, and only accepted inquiries are
 * counted.
 */
export interface InquiryStore {
  admit(request: InquiryAdmissionRequest): Promise<InquiryAdmission>;
}

/** The public projection of an offered mode capability: no profile hash, no evidence, no review trigger. */
export interface PublishedCapability {
  readonly capabilityId: CapabilityId;
  readonly mode: ServiceMode;
  readonly version: string;
  readonly state: "AVAILABLE_LIMITED" | "AVAILABLE";
  readonly validFrom: UtcInstant;
}

export interface CapabilityPublication {
  /**
   * The MODE capabilities in an offered state (AVAILABLE_LIMITED, AVAILABLE) that carry the instant they became valid, ordered by
   * mode. Never a DESIGN, implemented, qualified or suspended capability, and never one that is not a mode.
   */
  listPublishable(): Promise<ReadonlyArray<PublishedCapability>>;
}
